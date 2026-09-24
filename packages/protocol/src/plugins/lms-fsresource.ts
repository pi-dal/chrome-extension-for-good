import type { SitePlugin } from '../index.js';

/**
 * Moodle + mod_fsresource video module, as measured on the SYSU deployment.
 *
 * This is the reference plugin: it is the only built-in whose credit field
 * (`totaltime` in the `mod_fsresource_set_time` heartbeat response) has been
 * verified against a live account, so `speed-probe` can judge playback rates on
 * it. Use it as the template for other Moodle-based deployments.
 */

const HEARTBEAT_METHOD = 'mod_fsresource_set_time';

/** Idempotently wraps XHR + fetch to RECORD the last heartbeat request/response. */
const HEARTBEAT_HOOK_JS = `
(() => {
  const w = window;
  if (w.__c4gHookInstalled) return true;
  w.__c4gHookInstalled = true;
  w.__c4gLastHeartbeat = null;
  var MATCH = '${HEARTBEAT_METHOD}';
  var record = function (url, requestBody, responseText) {
    try {
      if (typeof url === 'string' && url.indexOf('service.php') !== -1 &&
          requestBody && String(requestBody).indexOf(MATCH) !== -1) {
        w.__c4gLastHeartbeat = {
          ts: Date.now(),
          url: String(url).slice(0, 500),
          requestBody: String(requestBody || '').slice(0, 1000),
          responseText: String(responseText || '').slice(0, 500)
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
  return true;
})()`;

const PLAYER_STATE_JS = `
(() => {
  var v = document.querySelector('video');
  var hb = window.__c4gLastHeartbeat || null;
  var totaltime = null, progress = null;
  if (hb) {
    var m1 = /"totaltime"\\s*:\\s*"?([\\d.]+)/i.exec(hb.responseText);
    if (m1) totaltime = parseFloat(m1[1]);
    var m2 = /"progress"\\s*:\\s*"?([\\d.]+)/i.exec(hb.responseText);
    if (m2) progress = parseFloat(m2[1]);
  }
  return {
    playing: !!v && !v.paused && !v.ended,
    currentTime: v ? v.currentTime : 0,
    duration: v ? v.duration : 0,
    rate: v ? v.playbackRate : 1,
    heartbeatTs: hb ? hb.ts : 0,
    totaltime: totaltime,
    progress: progress,
    url: location.href
  };
})()`;

const COURSE_IDS_JS = `
(() => {
  var seen = new Set(); var out = [];
  var re = /mod\\/fsresource\\/view\\.php\\?id=(\\d+)/g;
  var html = document.documentElement.innerHTML; var m;
  while ((m = re.exec(html)) !== null) {
    if (!seen.has(m[1])) { seen.add(m[1]); out.push(Number(m[1])); }
  }
  return JSON.stringify(out);
})()`;

export const LMS_FSRESOURCE_PLUGIN: SitePlugin = {
  id: 'lms-fsresource',
  label: 'Moodle video module (mod_fsresource)',
  match: { video: '/mod/fsresource/view.php', course: '/course/view.php', quizAny: ['/mod/quiz/'] },
  heartbeatUrlPattern: HEARTBEAT_METHOD,
  heartbeatHookJs: HEARTBEAT_HOOK_JS,
  playerStateJs: PLAYER_STATE_JS,
  courseIdsJs: COURSE_IDS_JS,
  videoUrlTemplate: '/mod/fsresource/view.php?id={id}',
  idPattern: 'view\\.php\\?id=(\\d+)',
  verified: true,
  source: 'measured on the target SYSU Moodle deployment (playerdata/totaltime/progress in mod_fsresource_set_time responses)',
  notes: 'Reference adapter: server-acked totaltime and progress are readable, so speed-probe and the rate gate work on it.',
  quiz: {
    progressSelector: '.num-bfjd span',
    // The platform's own button texts (Chinese UI) — matched literally.
    navLabels: ['检查', '保存', '下一页', '上一页', '提交', '交卷', '开始作答'],
    verified: false,
    source: "sysu-lms field notes (progress widget .num-bfjd span, elapsed .num-gksc span) + this repo's capture corpus",
    notes:
      'Progress reading is sourced; quiz DOM selectors are NOT (no verified .que/.answer selectors here) — inspect falls back to its heuristics/LLM, and `inspect --learn` distils per-origin selectors into data/recipes. Add questionSelector/optionSelector once you confirm them on a live attempt page.',
  },
  forge: {
    timeFieldPattern: '"(?:time|totaltime|playingTime|position)"\\s*:\\s*"?\\d+(?:\\.\\d+)?',
    note:
      'Replays the recorded mod_fsresource_set_time POST with the position field rewritten. Field name unverified (the hook captures the real body: check data/speed-policy.json evidence or DevTools). This deployment is expected to ignore forged positions — report-probe decides, and the driver disables itself when the ack does not move.',
  },
};
