import type { SitePlugin } from '../index.js';

/**
 * China University MOOC (icourse163) — derived from the open-source cxmooc-tools
 * implementation (see `source`).
 *
 * Facts taken from that project:
 *   - the learn page is `www.icourse163.org/learn/*` with a `/spoc/learn/*`
 *     variant, and it is a hash-routed SPA: the video identity never reaches the
 *     path, so there is no per-video URL to queue;
 *   - the media element is any `video[id]` on that page;
 *   - lesson units arrive over DWR callbacks — `CourseBean.getLessonUnitLearnVo.dwr`
 *     carries the `videoVo` unit (video metadata), `MocQuizBean.getQuizPaperDto.dwr`
 *     and `PostBean.getPaginationReplys.dwr` carry quizzes/posts.
 *
 * `verified` is false: not exercised against a live account here, and no
 * cumulative credit field was identified in those callbacks, so the hook records
 * them for the operator to extend.
 */

const HOOK_JS = `
(() => {
  const w = window;
  if (w.__c4gHookInstalled) return true;
  w.__c4gHookInstalled = true;
  w.__c4gLastHeartbeat = null;
  w.__c4gMooc = w.__c4gMooc || { units: null, count: 0 };
  var UNIT = 'getLessonUnitLearnVo.dwr';
  var record = function (url, requestBody, responseText) {
    try {
      var text = String(responseText || '');
      if (typeof url !== 'string' || url.indexOf(UNIT) === -1) return;
      w.__c4gMooc.count += 1;
      w.__c4gMooc.units = text.slice(0, 1000);
      w.__c4gLastHeartbeat = {
        ts: Date.now(),
        requestBody: String(requestBody || url).slice(0, 1000),
        responseText: text.slice(0, 500)
      };
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
  return true;
})()`;

const PLAYER_STATE_JS = `
(() => {
  var v = document.querySelector('video[id]') || document.querySelector('video');
  var hb = window.__c4gLastHeartbeat || null;
  /* No cumulative credit field identified yet: totaltime/progress stay null,
     the rate gate falls back to 1x, and speed-probe reports unobservable. */
  return {
    playing: !!v && !v.paused && !v.ended,
    currentTime: v ? v.currentTime : 0,
    duration: v ? v.duration : 0,
    rate: v ? v.playbackRate : 1,
    heartbeatTs: hb ? hb.ts : 0,
    totaltime: null,
    progress: null,
    url: location.href
  };
})()`;

export const ICOURSE163_PLUGIN: SitePlugin = {
  id: 'icourse163',
  label: 'China University MOOC (icourse163)',
  match: { video: 'icourse163.org/learn/', videoAny: ['icourse163.org/spoc/learn/'] },
  heartbeatHookJs: HOOK_JS,
  playerStateJs: PLAYER_STATE_JS,
  quiz: {
    questionSelector: '.u-questionItem',
    optionSelector: '.u-tbl.f-pr.f-cb',
    // Platform button texts (Chinese UI), matched literally.
    navLabels: ['提交', '保存', '下一题', '上一题'],
    verified: false,
    source: 'github.com/CodFrm/cxmooc-tools src/mooc/course163/question.ts @ master (.u-questionItem / .u-tbl.f-pr.f-cb / input[type=radio|checkbox] / textarea)',
    notes:
      'Question and option selectors come from the referenced implementation; the submit/save button labels are unverified. inspect still audits conservation and falls back to heuristics/LLM when a selector fails to confirm.',
  },
  verified: false,
  source: 'github.com/CodFrm/cxmooc-tools src/mooc/course163/*.ts + src/config.ts match list @ master',
  notes:
    'Derived, not measured live. The learn page is a hash-routed SPA, so there is no per-video URL: chain/queue addressing is unavailable and `watch` supervises the open page instead. The hook records the CourseBean.getLessonUnitLearnVo.dwr unit payload (videoVo) so a cumulative field can be wired into totaltime/progress later; until then speed-probe reports unobservable and the rate gate stays 1x.',
};
