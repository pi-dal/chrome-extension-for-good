import type { SitePlugin } from '../index.js';

/**
 * Zhihuishu / Zhidao (zhihuishu) — video page and credit source derived from the
 * open-source cxmooc-tools implementation (see `source`).
 *
 * Facts taken from that project:
 *   - the video page is `studyh5.zhihuishu.com/videoStudy.html` (hash-routed
 *     SPA with an in-page playlist, so the URL carries no per-video id);
 *   - the player is video.js with the media element `#vjs_container_html5_api`;
 *   - watch time is reported to `studyservice.zhihuishu.com/learning/saveDatabaseIntervalTime`;
 *   - the server-acked accumulated seconds arrive as `studiedLessonDto.studyTotalTime`
 *     in `learning/prelearningNote` responses — that is this plugin's `totaltime`.
 *
 * It was NOT measured against a live account here: `verified` is false, and the
 * hook below reads `studyTotalTime` from ANY intercepted response so it does not
 * depend on which call happens to carry it.
 */

const HOOK_JS = `
(() => {
  const w = window;
  if (w.__c4gHookInstalled) return true;
  w.__c4gHookInstalled = true;
  w.__c4gZhs = w.__c4gZhs || { credited: null, creditedAt: 0, heartbeat: null, videoList: null, note: null, nowVideoId: null, watchPointPost: null };

  /* The report is assembled from the lesson list, the current note and the
     player's own video id, so capture them the way the referenced
     implementation does (it hooks createPlayer and reads args[1].id). */
  var capturePlayerId = function () {
    try {
      var host = w.PlayerStarter;
      var fn = host && typeof host.createPlayer === 'function' ? host.createPlayer : (typeof host === 'function' ? host : null);
      if (!fn || fn.__c4gWrapped) return;
      var wrapped = function (a, b) {
        try {
          var id = b && typeof b.id !== 'undefined' ? b.id : (a && typeof a.id !== 'undefined' ? a.id : null);
          if (id !== null) w.__c4gZhs.nowVideoId = id;
        } catch (e) {}
        return fn.apply(this, arguments);
      };
      wrapped.__c4gWrapped = true;
      if (host && typeof host.createPlayer === 'function') host.createPlayer = wrapped;
      else w.PlayerStarter = wrapped;
    } catch (e) {}
  };
  capturePlayerId();
  var CREDIT = /"studyTotalTime"\\s*:\\s*"?([\\d.]+)/;
  var REPORT = 'saveDatabaseIntervalTime';
  var record = function (url, requestBody, responseText) {
    try {
      var text = String(responseText || '');
      var m = CREDIT.exec(text);
      if (m) {
        w.__c4gZhs.credited = parseFloat(m[1]);
        w.__c4gZhs.creditedAt = Date.now();
      }
      if (typeof url === 'string' && url.indexOf('learning/videolist') !== -1) {
        try {
          var list = JSON.parse(text);
          if (list && list.data) w.__c4gZhs.videoList = list.data;
        } catch (e) {}
      }
      if (typeof url === 'string' && url.indexOf('prelearningNote') !== -1) {
        try {
          var note = JSON.parse(text);
          var dto = note && note.data && note.data.studiedLessonDto;
          if (dto) w.__c4gZhs.note = { id: dto.id, studyTotalTime: dto.studyTotalTime };
        } catch (e) {}
      }
      if (typeof url === 'string' && url.indexOf(REPORT) !== -1) {
        w.__c4gZhs.heartbeat = {
          ts: Date.now(),
          url: String(url).slice(0, 500),
          requestBody: String(requestBody || '').slice(0, 1000),
          responseText: text.slice(0, 500)
        };
      }
    } catch (e) {}
  };
  var XHR = w.XMLHttpRequest && w.XMLHttpRequest.prototype;
  if (XHR && !XHR.__c4gPatched) {
    XHR.__c4gPatched = true;
    var origOpen = XHR.open, origSend = XHR.send;
    XHR.open = function (method, url) { this.__c4gUrl = url; return origOpen.apply(this, arguments); };
    XHR.send = function (body) {
      var xhr = this;
      xhr.addEventListener('load', function () { record(xhr.__c4gUrl, body, xhr.responseText); });
      return origSend.apply(this, arguments);
    };
  }
  if (w.fetch && !w.fetch.__c4gPatched) {
    var origFetch = w.fetch;
    var patched = function (input, init) {
      var url = typeof input === 'string' ? input : (input && input.url) || '';
      var body = init && init.body;
      return origFetch.apply(this, arguments).then(function (resp) {
        try { resp.clone().text().then(function (t) { record(url, body, t); }); } catch (e) {}
        return resp;
      });
    };
    patched.__c4gPatched = true;
    w.fetch = patched;
  }
  capturePlayerId();
  return true;
})()`;

const PLAYER_STATE_JS = `
(() => {
  var v = document.querySelector('#vjs_container_html5_api') || document.querySelector('video');
  var st = window.__c4gZhs || {};
  var credited = typeof st.credited === 'number' ? st.credited : null;
  var hb = st.heartbeat || null;
  var duration = v ? v.duration : 0;
  return {
    playing: !!v && !v.paused && !v.ended,
    currentTime: v ? v.currentTime : 0,
    duration: duration,
    rate: v ? v.playbackRate : 1,
    heartbeatTs: hb ? hb.ts : 0,
    totaltime: credited,
    progress: credited !== null && duration > 0 ? Math.min(100, (credited / duration) * 100) : null,
    url: location.href
  };
})()`;

/**
 * The platform's report body is signed with an obfuscated `ev` string and a
 * `watchPoint` chain. Both are ported here from the referenced open-source
 * implementation, which resolves to (see the test that re-derives it):
 *
 *   ev        = hex2(c_i XOR KEY[i % 8]) for every char of
 *               [recruitId, lessonId, smallLessonId, nowVideoId, chapterId, '0', tn, studyTotalTime, durationText].join(';')
 *               with KEY = "zzpttjd" — the `n.Z/n.X/n.Y` helpers decoded
 *   watchPoint (re)built by appending `parseInt(studyTotalTime / 5 + 2)` and
 *               bumping studyTotalTime by 2, once per ~2 seconds claimed
 *   POST      saveDatabaseIntervalTime (form-encoded, page credentials)
 *
 * Nothing here replays a *recorded* body: the fields are recomputed, which is
 * what a signed report requires.
 */
export const ZHIHUISHU_FORGE_JS = `(async () => {
  const w = window;
  const st = w.__c4gZhs || {};
  const list = st.videoList;
  const note = st.note;
  if (!list || !list.videoChapterDtos) return { ok: false, status: null, detail: 'lecture list not captured yet (learning/videolist response needed)' };
  if (!note || note.id === undefined) return { ok: false, status: null, detail: 'lesson note not captured yet (learning/prelearningNote response needed)' };
  if (st.nowVideoId === null || st.nowVideoId === undefined) return { ok: false, status: null, detail: 'player video id not captured yet (PlayerStarter.createPlayer hook needs one load)' };

  const mark = document.querySelector('.current_play .hour');
  const dur = document.querySelector('.nPlayTime .duration');
  const v = document.querySelector('#vjs_container_html5_api') || document.querySelector('video');
  if (!mark || !dur || !v) return { ok: false, status: null, detail: 'page shape changed (missing .current_play .hour / .nPlayTime .duration / video)' };

  const parts = String(mark.innerText).trim().split('.').map(function (n) { return parseInt(n, 10); });
  const chapter = list.videoChapterDtos[parts[0] - 1];
  const lesson = chapter && chapter.videoLessons ? chapter.videoLessons[parts[1] - 1] : null;
  if (!lesson) return { ok: false, status: null, detail: 'current lesson not found in the captured lecture list' };
  const smallLesson = parts.length >= 3 && lesson.videoSmallLessons ? lesson.videoSmallLessons[parts[2] - 1] : null;

  const durationText = String(dur.innerText);
  const nums = (durationText.match(/\\d+/g) || []).map(Number);
  let duration = 0;
  for (let i = 0; i < 3; i++) duration += (nums[i] || 0) * Math.pow(60, 2 - i);
  if (!duration) return { ok: false, status: null, detail: 'could not read the duration text: ' + durationText };

  const target = Number(w.__c4gForgePosition);
  const claimed = Math.max(1, Math.min(Math.round(target) || duration, duration));
  const tn = claimed + 20 + Math.floor(Math.random() * 180);

  // watchPoint chain + credited seconds, mirroring learningTimeRecord()
  let watchPoint = st.watchPointPost && st.watchPointPost !== '' ? st.watchPointPost : null;
  let studyTotalTime = typeof note.studyTotalTime === 'number' ? note.studyTotalTime : 0;
  const steps = Math.max(1, parseInt(String(tn / 1.999), 10));
  for (let i = 0; i < steps; i++) {
    const prefix = watchPoint === null || watchPoint === '' ? '0,1,' : watchPoint + ',';
    const t = parseInt(String(studyTotalTime / 5 + 2), 10);
    watchPoint = prefix + t;
    studyTotalTime += 2;
  }

  const KEY = 'zzpttjd';
  const encode = function (text) {
    let out = '';
    for (let i = 0; i < text.length; i++) {
      const x = text.charCodeAt(i) ^ KEY.charCodeAt(i % KEY.length);
      const hex = x.toString(16);
      out += hex.length < 2 ? '0' + hex : hex;
    }
    return out;
  };
  const ev = encode([
    list.recruitId, lesson.id, smallLesson ? smallLesson.id : 0, st.nowVideoId,
    lesson.chapterId, '0', tn, studyTotalTime, durationText,
  ].join(';'));

  const cookie = String(document.cookie || '');
  const from = cookie.indexOf('uuid%22%3A%22');
  const uuid = from === -1 ? '' : cookie.slice(from + 12, cookie.indexOf('%22', from + 12));
  const body = 'watchPoint=' + encodeURIComponent(watchPoint) +
    '&ev=' + encodeURIComponent(ev) +
    '&courseId=' + encodeURIComponent(String(list.courseId)) +
    '&learningTokenId=' + encodeURIComponent(btoa(String(note.id))) +
    '&uuid=' + encodeURIComponent(uuid) +
    '&dateFormate=' + encodeURIComponent(String(Date.parse(new Date())));

  try {
    const resp = await fetch('https://studyservice.zhihuishu.com/learning/saveDatabaseIntervalTime', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body,
    });
    const text = await resp.text();
    return { ok: resp.ok, status: resp.status, detail: String(text).slice(0, 300) };
  } catch (e) {
    return { ok: false, status: null, detail: 'replay failed: ' + String(e) };
  }
})()`;

export const ZHIHUISHU_PLUGIN: SitePlugin = {
  id: 'zhihuishu',
  label: 'Zhihuishu / Zhidao (videoStudy)',
  match: { video: 'studyh5.zhihuishu.com/videoStudy.html' },
  heartbeatUrlPattern: 'saveDatabaseIntervalTime',
  heartbeatHookJs: HOOK_JS,
  playerStateJs: PLAYER_STATE_JS,
  verified: false,
  source: 'github.com/CodFrm/cxmooc-tools src/mooc/zhihuishu/{platform,video}.ts @ master',
  notes:
    'Derived, not measured live. Credit comes from studiedLessonDto.studyTotalTime (any response carrying it); if the value only refreshes on lesson switches, speed-probe will report unobservable. The page is a hash-routed SPA with an in-page playlist: no per-video URL, so chain/queue addressing is unavailable — use `watch` on the open video page. The referenced project also notes playback speed does not drive progress there.',
  quiz: {
    // Platform button texts (Chinese UI), matched literally.
    navLabels: ['下一题', '上一题', '提交'],
    verified: false,
    source: 'no sourced quiz DOM (the referenced implementation handles exams in src/mooc/zhihuishu/exam.ts)',
    notes:
      'Only nav labels shipped; the exam DOM is not transcribed. Run `inspect --learn` on an exam page to learn selectors.',
  },
  forge: {
    replayJs: ZHIHUISHU_FORGE_JS,
    note:
      'Platform script: recomputes the signed body (obfuscated ev + watchPoint chain ported from the referenced implementation) and POSTs saveDatabaseIntervalTime. Needs the hook to have captured videolist/prelearningNote/nowVideoId; it fails loudly if any is missing.',
  },
};
