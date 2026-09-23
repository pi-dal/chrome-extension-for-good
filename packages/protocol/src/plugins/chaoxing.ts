import type { SitePlugin } from '../index.js';

/**
 * Chaoxing / Xuexitong (chaoxing) — derived from the open-source cxmooc-tools
 * implementation (see `source`).
 *
 * Facts taken from that project:
 *   - the video runs in an iframe whose URL contains
 *     `ananas/modules/video/index.html` (its URL params — objectId, jobid,
 *     clazzId, reportUrl, dtoken, enc — are minted by the parent page);
 *   - the media element is video.js `#video_html5_api`;
 *   - progress is reported by GETting `param.reportUrl + '/' + dtoken` with
 *     `playingTime`, `isdrag=4` and a signed `enc`, and the JSON answer carries
 *     `isPassed` (a boolean) — no cumulative seconds.
 *
 * `verified` is false: this was not exercised against a live account here.
 */

const HOOK_JS = `
(() => {
  const w = window;
  if (w.__c4gHookInstalled) return true;
  w.__c4gHookInstalled = true;
  w.__c4gLastHeartbeat = null;
  w.__c4gCx = w.__c4gCx || { lastReport: null, lastVerdict: null, initData: null, params: null };

  /* The report URL and its enc signature are built from the player's own params
     (reportUrl/dtoken/clazzId/userid/jobid/objectId/duration/otherInfo), so the
     plugin captures them the same way the referenced implementation does. */
  var captureParams = function () {
    try {
      var ans = w.ans;
      var proto = ans && ans.VideoJs && ans.VideoJs.prototype;
      if (!proto || proto.__c4gParamsHooked) return;
      proto.__c4gParamsHooked = true;
      var orig = proto.params2VideoOpt;
      if (typeof orig !== 'function') return;
      proto.params2VideoOpt = function (param) {
        try { w.__c4gCx.params = param || null; } catch (e) {}
        return orig.apply(this, arguments);
      };
    } catch (e) {}
  };
  captureParams();
  var isReport = function (url) {
    return typeof url === 'string' && (url.indexOf('multimedia/log') !== -1 || url.indexOf('/multimedia/log') !== -1);
  };
  var record = function (url, requestBody, responseText) {
    try {
      var text = String(responseText || '');
      if (isReport(url)) {
        w.__c4gLastHeartbeat = {
          ts: Date.now(),
          requestBody: String(requestBody || url || '').slice(0, 1000),
          responseText: text.slice(0, 500)
        };
        var m = /"isPassed"\\s*:\\s*(true|false)/.exec(text);
        if (m) w.__c4gCx.lastVerdict = m[1] === 'true';
        w.__c4gCx.lastReport = { ts: Date.now(), url: String(url).slice(0, 300) };
      } else if (typeof url === 'string' && url.indexOf('initdatawithviewer') !== -1) {
        w.__c4gCx.initData = text.slice(0, 500);
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
  captureParams();
  return true;
})()`;

const PLAYER_STATE_JS = `
(() => {
  var v = document.querySelector('#video_html5_api') || document.querySelector('video');
  var hb = window.__c4gLastHeartbeat || null;
  /* The report answers with a pass/fail verdict, not accumulated seconds, so
     totaltime/progress stay null and the rate gate falls back to 1x. Extend the
     hook and this expression once a cumulative field is identified. */
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

export const CHAOXING_MD5_JS = `var md5 = (function () {
  function add32(a, b) { return (a + b) & 0xFFFFFFFF; }
  function cmn(q, a, b, x, s, t) {
    a = add32(add32(a, q), add32(x, t));
    return add32((a << s) | (a >>> (32 - s)), b);
  }
  function ff(a, b, c, d, x, s, t) { return cmn((b & c) | (~b & d), a, b, x, s, t); }
  function gg(a, b, c, d, x, s, t) { return cmn((b & d) | (c & ~d), a, b, x, s, t); }
  function hh(a, b, c, d, x, s, t) { return cmn(b ^ c ^ d, a, b, x, s, t); }
  function ii(a, b, c, d, x, s, t) { return cmn(c ^ (b | ~d), a, b, x, s, t); }
  function md5cycle(x, k) {
    var a = x[0], b = x[1], c = x[2], d = x[3];
    a = ff(a, b, c, d, k[0], 7, -680876936); d = ff(d, a, b, c, k[1], 12, -389564586);
    c = ff(c, d, a, b, k[2], 17, 606105819); b = ff(b, c, d, a, k[3], 22, -1044525330);
    a = ff(a, b, c, d, k[4], 7, -176418897); d = ff(d, a, b, c, k[5], 12, 1200080426);
    c = ff(c, d, a, b, k[6], 17, -1473231341); b = ff(b, c, d, a, k[7], 22, -45705983);
    a = ff(a, b, c, d, k[8], 7, 1770035416); d = ff(d, a, b, c, k[9], 12, -1958414417);
    c = ff(c, d, a, b, k[10], 17, -42063); b = ff(b, c, d, a, k[11], 22, -1990404162);
    a = ff(a, b, c, d, k[12], 7, 1804603682); d = ff(d, a, b, c, k[13], 12, -40341101);
    c = ff(c, d, a, b, k[14], 17, -1502002290); b = ff(b, c, d, a, k[15], 22, 1236535329);
    a = gg(a, b, c, d, k[1], 5, -165796510); d = gg(d, a, b, c, k[6], 9, -1069501632);
    c = gg(c, d, a, b, k[11], 14, 643717713); b = gg(b, c, d, a, k[0], 20, -373897302);
    a = gg(a, b, c, d, k[5], 5, -701558691); d = gg(d, a, b, c, k[10], 9, 38016083);
    c = gg(c, d, a, b, k[15], 14, -660478335); b = gg(b, c, d, a, k[4], 20, -405537848);
    a = gg(a, b, c, d, k[9], 5, 568446438); d = gg(d, a, b, c, k[14], 9, -1019803690);
    c = gg(c, d, a, b, k[3], 14, -187363961); b = gg(b, c, d, a, k[8], 20, 1163531501);
    a = gg(a, b, c, d, k[13], 5, -1444681467); d = gg(d, a, b, c, k[2], 9, -51403784);
    c = gg(c, d, a, b, k[7], 14, 1735328473); b = gg(b, c, d, a, k[12], 20, -1926607734);
    a = hh(a, b, c, d, k[5], 4, -378558); d = hh(d, a, b, c, k[8], 11, -2022574463);
    c = hh(c, d, a, b, k[11], 16, 1839030562); b = hh(b, c, d, a, k[14], 23, -35309556);
    a = hh(a, b, c, d, k[1], 4, -1530992060); d = hh(d, a, b, c, k[4], 11, 1272893353);
    c = hh(c, d, a, b, k[7], 16, -155497632); b = hh(b, c, d, a, k[10], 23, -1094730640);
    a = hh(a, b, c, d, k[13], 4, 681279174); d = hh(d, a, b, c, k[0], 11, -358537222);
    c = hh(c, d, a, b, k[3], 16, -722521979); b = hh(b, c, d, a, k[6], 23, 76029189);
    a = hh(a, b, c, d, k[9], 4, -640364487); d = hh(d, a, b, c, k[12], 11, -421815835);
    c = hh(c, d, a, b, k[15], 16, 530742520); b = hh(b, c, d, a, k[2], 23, -995338651);
    a = ii(a, b, c, d, k[0], 6, -198630844); d = ii(d, a, b, c, k[7], 10, 1126891415);
    c = ii(c, d, a, b, k[14], 15, -1416354905); b = ii(b, c, d, a, k[5], 21, -57434055);
    a = ii(a, b, c, d, k[12], 6, 1700485571); d = ii(d, a, b, c, k[3], 10, -1894986606);
    c = ii(c, d, a, b, k[10], 15, -1051523); b = ii(b, c, d, a, k[1], 21, -2054922799);
    a = ii(a, b, c, d, k[8], 6, 1873313359); d = ii(d, a, b, c, k[15], 10, -30611744);
    c = ii(c, d, a, b, k[6], 15, -1560198380); b = ii(b, c, d, a, k[13], 21, 1309151649);
    a = ii(a, b, c, d, k[4], 6, -145523070); d = ii(d, a, b, c, k[11], 10, -1120210379);
    c = ii(c, d, a, b, k[2], 15, 718787259); b = ii(b, c, d, a, k[9], 21, -343485551);
    x[0] = add32(a, x[0]); x[1] = add32(b, x[1]); x[2] = add32(c, x[2]); x[3] = add32(d, x[3]);
  }
  /* UTF-8 bytes, computed by hand: charCodeAt() would hash UTF-16 units and
     produce a different digest for any non-ASCII parameter. */
  function utf8(s) {
    var out = '', i, c, next;
    for (i = 0; i < s.length; i++) {
      c = s.charCodeAt(i);
      if (c < 0x80) out += String.fromCharCode(c);
      else if (c < 0x800) out += String.fromCharCode(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
      else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
        next = s.charCodeAt(i + 1);
        if (next >= 0xdc00 && next <= 0xdfff) {
          c = 0x10000 + ((c - 0xd800) << 10) + (next - 0xdc00);
          i++;
          out += String.fromCharCode(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 0x3f), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
        } else out += String.fromCharCode(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
      } else out += String.fromCharCode(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
    }
    return out;
  }
  return function (input) {
    var s = utf8(input);
    var i, n = s.length, state = [1732584193, -271733879, -1732584194, 271733878];
    for (i = 64; i <= n; i += 64) {
      md5cycle(state, md5blk(s.substring(i - 64, i)));
    }
    s = s.substring(i - 64);
    var tail = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    for (i = 0; i < s.length; i++) tail[i >> 2] |= s.charCodeAt(i) << ((i % 4) << 3);
    tail[i >> 2] |= 0x80 << ((i % 4) << 3);
    if (i > 55) {
      md5cycle(state, tail);
      for (i = 0; i < 16; i++) tail[i] = 0;
    }
    tail[14] = n * 8;
    md5cycle(state, tail);
    return state;
  };
  function md5blk(s) {
    var md5blks = [], i;
    for (i = 0; i < 64; i += 4) {
      md5blks[i >> 2] = s.charCodeAt(i) + (s.charCodeAt(i + 1) << 8) + (s.charCodeAt(i + 2) << 16) + (s.charCodeAt(i + 3) << 24);
    }
    return md5blks;
  }
})();`;

export const CHAOXING_FORGE_JS = `(async () => {
  ${CHAOXING_MD5_JS}
  const w = window;
  const p = (w.__c4gCx && w.__c4gCx.params) || null;
  if (!p || !p.reportUrl) return { ok: false, status: null, detail: 'player params not captured yet (the ans.VideoJs proto hook needs one load)' };
  const v = document.querySelector('#video_html5_api') || document.querySelector('video');
  const duration = Math.round(Number(p.duration) || (v ? v.duration : 0) || 0);
  if (!duration) return { ok: false, status: null, detail: 'no duration available (player params missing duration)' };
  const target = Number(w.__c4gForgePosition);
  const playTime = Math.max(1, Math.min(Math.round(target) || duration, duration));
  const block = md5('[' + p.clazzId + '][' + p.userid + '][' + p.jobid + '][' + p.objectId + '][' +
    (playTime * 1000).toString() + '][d_yHJ!$pdA~5][' + (duration * 1000).toString() + '][0_' + duration + ']');
  let enc = '';
  for (let i = 0; i < block.length; i++) {
    for (let b = 0; b < 4; b++) {
      const byte = (block[i] >> (b * 8)) & 0xff;
      enc += (byte < 16 ? '0' : '') + byte.toString(16);
    }
  }
  const url = p.reportUrl + '/' + p.dtoken + '?clipTime=0_' + duration +
    '&otherInfo=' + p.otherInfo + '&userid=' + p.userid + '&rt=0.9&jobid=' + p.jobid +
    '&duration=' + duration + '&dtype=Video&objectId=' + p.objectId + '&clazzId=' + p.clazzId +
    '&view=pc&playingTime=' + playTime + '&isdrag=4&enc=' + enc;
  try {
    const resp = await fetch(url, { credentials: 'include' });
    const text = await resp.text();
    return { ok: resp.ok, status: resp.status, detail: String(text).slice(0, 300) };
  } catch (e) {
    return { ok: false, status: null, detail: 'replay failed: ' + String(e) };
  }
})()`;

export const CHAOXING_PLUGIN: SitePlugin = {
  id: 'chaoxing-video',
  label: 'Chaoxing / Xuexitong (ananas player)',
  match: { video: 'ananas/modules/video/index.html' },
  heartbeatHookJs: HOOK_JS,
  playerStateJs: PLAYER_STATE_JS,
  verified: false,
  source: 'github.com/CodFrm/cxmooc-tools src/mooc/chaoxing/{platform,video}.ts @ master',
  quiz: {
    verified: false,
    source: 'no sourced quiz DOM: the referenced implementation keeps its question handling in src/mooc/chaoxing/question.ts (not transcribed here)',
    notes:
      'No quiz selectors shipped on purpose — run `inspect --learn` on a live attempt page (work/doHomeWorkNew, exam/test/reVersionTestStartNew) to distil per-origin selectors into data/recipes, then paste them here.',
  },
  forge: {
    replayJs: CHAOXING_FORGE_JS,
    note:
      'Platform script: rebuilds the signed report from the captured player params and re-signs it with md5 (salt ported from the referenced implementation). Needs one hook pass to capture params; the report is a GET with playingTime + isdrag=4, exactly as the player issues it.',
  },
  notes:
    'Derived, not measured live. The player sits in a same-tenant iframe whose params are minted by the parent, so mycourse/studentstudy is intentionally unmatched (cross-origin iframe work is out of scope): attach to the player frame URL. The signed report (multimedia/log, dtoken+enc, pass/fail rather than seconds) is recorded by the hook but deliberately not declared as heartbeatUrlPattern, so the generic observer can still report its cadence. totaltime stays null, rate gate 1x.',
};

/**
 * Compact MD5 (RFC 1321) — the platform signs its report with
 * `md5('[clazzId][userid][jobid][objectId][playTime*1000][d_yHJ!$pdA~5][duration*1000][0_duration]')`,
 * so a replayed position has to be re-signed with the same salt.
 */
