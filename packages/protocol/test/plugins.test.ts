import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  BUILTIN_PLUGINS,
  CHAOXING_FORGE_JS,
  CHAOXING_MD5_JS,
  CHAOXING_PLUGIN,
  ICOURSE163_PLUGIN,
  LMS_FSRESOURCE_PLUGIN,
  ZHIHUISHU_FORGE_JS,
  ZHIHUISHU_PLUGIN,
  parseExtToHost,
  parseSitePlugin,
  parseSitePlugins,
  PLUGIN_LIMITS,
  type ExtToHost,
  type SitePlugin,
} from '../src/index.js';

function plugin(over: Partial<SitePlugin> = {}): SitePlugin {
  return {
    id: 'demo',
    label: 'Demo platform',
    match: { video: '/watch/', course: '/list/' },
    heartbeatHookJs: '(() => true)()',
    playerStateJs: '(() => ({ playing: true }))()',
    courseIdsJs: '(() => "[]")()',
    videoUrlTemplate: '/watch/{id}',
    idPattern: '/watch/(\\d+)',
    ...over,
  };
}

test('the built-in LMS plugin is a valid plugin and carries the LMS specifics', () => {
  const parsed = parseSitePlugin(LMS_FSRESOURCE_PLUGIN);
  assert.equal(parsed.id, 'lms-fsresource');
  assert.equal(parsed.match.video, '/mod/fsresource/view.php');
  assert.equal(parsed.match.course, '/course/view.php');
  assert.equal(parsed.heartbeatUrlPattern, 'mod_fsresource_set_time');
  assert.match(parsed.videoUrlTemplate!, /\{id\}/);
  assert.match(parsed.videoUrlTemplate!, /view\.php/);
  // the JS probes are the ones the runtime evaluates in the MAIN world
  assert.match(parsed.heartbeatHookJs, /__c4gLastHeartbeat/);
  assert.match(parsed.playerStateJs, /querySelector\('video'\)/);
  assert.match(parsed.courseIdsJs!, /fsresource/);
  assert.equal(BUILTIN_PLUGINS[0]!.id, 'lms-fsresource', 'the measured adapter leads the catalog');
  assert.equal(parsed.verified, true);
});

test('idPattern must actually extract an id from a video url', () => {
  const re = new RegExp(LMS_FSRESOURCE_PLUGIN.idPattern!);
  assert.equal(re.exec('https://lms.example.com/mod/fsresource/view.php?id=512')![1], '512');
});

test('parseSitePlugin accepts a minimal plugin and defaults nothing silently', () => {
  const minimal = parseSitePlugin({ id: 'x', match: { video: '/v/' }, heartbeatHookJs: 'h', playerStateJs: 'p' });
  assert.deepEqual(minimal, { id: 'x', match: { video: '/v/' }, heartbeatHookJs: 'h', playerStateJs: 'p' });
  assert.equal(minimal.videoUrlTemplate, undefined);
  assert.equal(minimal.courseIdsJs, undefined);
});

test('parseSitePlugin rejects malformed plugins with actionable messages', () => {
  const cases: Array<[string, unknown]> = [
    ['not an object', 'demo'],
    ['bad id chars', plugin({ id: 'bad id!' })],
    ['empty match.video', plugin({ match: { video: '' } })],
    ['missing hook', { id: 'x', match: { video: '/v/' }, playerStateJs: 'p' }],
    ['missing playerStateJs', { id: 'x', match: { video: '/v/' }, heartbeatHookJs: 'h' }],
    ['template without placeholder', plugin({ videoUrlTemplate: '/watch/' })],
    ['idPattern without a capture group', plugin({ idPattern: '/watch/\\d+' })],
    ['idPattern that is not a regex', plugin({ idPattern: '[' })],
    ['heartbeatHookJs too large', plugin({ heartbeatHookJs: 'x'.repeat(PLUGIN_LIMITS.maxJsBytes + 1) })],
    ['playerStateJs too large', plugin({ playerStateJs: 'x'.repeat(PLUGIN_LIMITS.maxJsBytes + 1) })],
    ['label too long', plugin({ label: 'x'.repeat(129) })],
  ];
  for (const [name, bad] of cases) {
    assert.throws(() => parseSitePlugin(bad), Error, `expected a throw for: ${name}`);
  }
});

test('parseSitePlugins enforces the list-level limits', () => {
  assert.deepEqual(parseSitePlugins([]), []);
  assert.deepEqual(parseSitePlugins([plugin(), plugin({ id: 'other' })]).map((p) => p.id), ['demo', 'other']);
  assert.throws(() => parseSitePlugins('nope'), /not an array/);
  assert.throws(() => parseSitePlugins([plugin(), plugin()]), /duplicate id/);
  assert.throws(
    () => parseSitePlugins(Array.from({ length: PLUGIN_LIMITS.maxPlugins + 1 }, (_, i) => plugin({ id: `p${i}` }))),
    /more than/,
  );
});

test('plugins_sync round-trips through the wire parser', () => {
  const msg: ExtToHost = { type: 'plugins_sync', plugins: [plugin(), LMS_FSRESOURCE_PLUGIN] };
  assert.deepEqual(parseExtToHost(JSON.parse(JSON.stringify(msg))), msg);
  assert.throws(() => parseExtToHost({ type: 'plugins_sync', plugins: [plugin(), plugin()] }), /duplicate id/);
  assert.throws(() => parseExtToHost({ type: 'plugins_sync' }), /not an array/);
});

test('a plugin can describe a completely different platform', () => {
  const other = parseSitePlugin(
    plugin({
      id: 'acme-video',
      match: { video: '/lesson/', course: '/catalog' },
      heartbeatHookJs: '(() => { window.__acmeHb = Date.now(); return true; })()',
      playerStateJs: '(() => ({ playing: !document.querySelector("video").paused }))()',
      videoUrlTemplate: '/lesson/{id}',
      idPattern: '/lesson/(\\d+)',
    }),
  );
  assert.equal(other.match.video, '/lesson/');
  assert.equal(other.heartbeatUrlPattern, undefined, 'no known heartbeat pattern → generic detection');
});

test('the built-in catalog is well formed, unique, and carries provenance', () => {
  const ids = BUILTIN_PLUGINS.map((p) => p.id);
  assert.deepEqual(ids, ['lms-fsresource', 'zhihuishu', 'chaoxing-video', 'icourse163']);
  assert.equal(new Set(ids).size, ids.length, 'duplicate plugin ids would shadow each other');
  for (const parsed of BUILTIN_PLUGINS.map((p) => parseSitePlugin(p))) {
    assert.ok((parsed.label ?? '').length > 0, `${parsed.id} needs a label`);
    assert.ok((parsed.source ?? '').length > 0, `${parsed.id} must say where it came from`);
    assert.ok((parsed.notes ?? '').length > 0, `${parsed.id} must say what is unverified`);
    assert.equal(typeof parsed.verified, 'boolean', `${parsed.id} must state its verification status`);
    // every alternative pattern is a real URL fragment, not a placeholder
    for (const alt of parsed.match.videoAny ?? []) assert.match(alt, /^[\w./-]+$/);
    for (const alt of parsed.match.courseAny ?? []) assert.match(alt, /^[\w./-]+$/);
    // url handling is optional, but when present it must round-trip
    if (parsed.videoUrlTemplate && parsed.idPattern) {
      const url = parsed.videoUrlTemplate.replace('{id}', '4242');
      assert.equal(new RegExp(parsed.idPattern).exec(url)?.[1], '4242', `${parsed.id} url/id pair must round-trip`);
    }
  }
});

test('only the measured adapter claims verification', () => {
  assert.equal(LMS_FSRESOURCE_PLUGIN.verified, true);
  for (const p of [ZHIHUISHU_PLUGIN, CHAOXING_PLUGIN, ICOURSE163_PLUGIN]) {
    assert.equal(p.verified, false, `${p.id} must not claim live verification`);
    assert.match(p.source!, /github\.com\/CodFrm\/cxmooc-tools/, `${p.id} must cite its source`);
  }
});

test('derived adapters state their limits honestly', () => {
  // Zhihuishu: has a cumulative credit field, but no per-video URL
  assert.equal(ZHIHUISHU_PLUGIN.heartbeatUrlPattern, 'saveDatabaseIntervalTime');
  assert.match(ZHIHUISHU_PLUGIN.heartbeatHookJs, /"studyTotalTime"/);
  assert.match(ZHIHUISHU_PLUGIN.playerStateJs, /__c4gZhs/);
  assert.match(ZHIHUISHU_PLUGIN.playerStateJs, /vjs_container_html5_api/);
  assert.equal(ZHIHUISHU_PLUGIN.idPattern, undefined);
  assert.match(ZHIHUISHU_PLUGIN.notes!, /hash-routed|hash route/);

  // Chaoxing: the player lives in an iframe; the report is signed and answers pass/fail
  assert.equal(CHAOXING_PLUGIN.match.video, 'ananas/modules/video/index.html');
  assert.match(CHAOXING_PLUGIN.notes!, /iframe/);
  assert.match(CHAOXING_PLUGIN.playerStateJs, /#video_html5_api/);
  assert.match(CHAOXING_PLUGIN.notes!, /signed|dtoken/);

  // China University MOOC: several player URLs, no cumulative field yet
  assert.deepEqual(ICOURSE163_PLUGIN.match.videoAny, ['icourse163.org/spoc/learn/']);
  assert.match(ICOURSE163_PLUGIN.playerStateJs, /video\[id\]/);
  assert.match(ICOURSE163_PLUGIN.notes!, /getLessonUnitLearnVo/);
});

test('match.videoAny is validated like the primary pattern', () => {
  const withAlts = plugin({ match: { video: '/a/', videoAny: ['/b/', '/c/'], courseAny: ['/d/'] } });
  assert.deepEqual(parseSitePlugin(withAlts).match.videoAny, ['/b/', '/c/']);
  assert.throws(() => parseSitePlugin({ ...withAlts, match: { video: '/a/', videoAny: [] } }), /non-empty array/);
  assert.throws(() => parseSitePlugin({ ...withAlts, match: { video: '/a/', videoAny: 'x' } }), /non-empty array/);
  assert.throws(
    () => parseSitePlugin({ ...withAlts, match: { video: '/a/', videoAny: Array.from({ length: 9 }, (_, i) => `/p${i}`) } }),
    /more than 8 entries/,
  );
});

test('provenance fields are validated and bounded', () => {
  assert.equal(parseSitePlugin(plugin({ verified: false })).verified, false);
  assert.throws(() => parseSitePlugin({ ...plugin(), verified: 'yes' }), /expected boolean/);
  assert.throws(() => parseSitePlugin({ ...plugin(), source: 'x'.repeat(513) }), /exceeds 512 bytes/);
  assert.throws(() => parseSitePlugin({ ...plugin(), notes: 'x'.repeat(513) }), /exceeds 512 bytes/);
});

// ---------------------------------------------------------------------------
// report replay (instant-pass / accelerated reporting) — the signature logic must be provably right
// ---------------------------------------------------------------------------

/** Run a plugin's in-page md5 source in Node and return the hex digest helper. */
function loadMd5(source: string): (s: string) => string {
  const md5 = new Function(`${source}; return md5;`)() as (s: string) => number[];
  return (s: string) => {
    let hex = '';
    for (const word of md5(s)) {
      for (let i = 0; i < 4; i++) {
        const byte = (word >>> (i * 8)) & 0xff;
        hex += byte.toString(16).padStart(2, '0');
      }
    }
    return hex;
  };
}

test('chaoxing replay signs reports with a correct MD5', async () => {
  const crypto = await import('node:crypto');
  const digest = loadMd5(CHAOXING_MD5_JS);
  const signature =
    '[1444][123456][work-job][object-1][60000][d_yHJ!$pdA~5][300000][0_300]';
  // ASCII and non-ASCII: the digest is over UTF-8 bytes, so both must match
  const samples = ['', 'abc', signature, 'x'.repeat(257), '超星', '视频\u{1f3ac}'];
  for (const sample of samples) {
    assert.equal(
      digest(sample),
      crypto.createHash('md5').update(sample).digest('hex'),
      `md5 mismatch for ${JSON.stringify(sample.slice(0, 24))}`,
    );
  }
  // the salt and the report shape the replay builds come from the reference
  assert.match(CHAOXING_FORGE_JS, /d_yHJ!\$pdA~5/);
  assert.match(CHAOXING_FORGE_JS, /playingTime=/);
  assert.match(CHAOXING_FORGE_JS, /isdrag=4/);
  assert.match(CHAOXING_FORGE_JS, /__c4gForgePosition/);
  assert.match(CHAOXING_FORGE_JS, /reportUrl/);
});

/**
 * The Zhihuishu signature is only reproducible if the port matches the obfuscated
 * helpers in the reference implementation. Re-derive those helpers from their
 * own lookup tables to prove the decoded algorithm is the one ported here:
 *   _c[8]+_a[4]+_c[15]+_a[1]+_a[8]+_b[6]      -> "length"
 *   _a[3]+_a[14]+_c[18]+_a[2]+...             -> "charCodeAt"
 *   _b[21]+_b[6]+_a[17]+_c[5]+...             -> "charCodeAt" (on the key)
 *   _b[3]+_a[4]+_b[4]+_a[1]+_c[7]+_c[9]       -> "length"
 *   _a[9]+_b[3]+_c[20]+_c[17]+_c[13]          -> "slice"
 */
test('zhihuishu encoder port matches the decoded reference helpers', () => {
  const a = 'AgrcepndtslzyohCia0uS@';
  const b = 'A0ilndhga@usreztoSCpyc';
  const c = 'd0@yorAtlhzSCeunpcagis';
  const key = 'zzpttjd';
  const pick = (src: string, idx: number[]): string => idx.map((i) => src[i]).join('');
  assert.equal(pick(c, [8]) + pick(a, [4]) + pick(c, [15]) + pick(a, [1]) + pick(a, [8]) + pick(b, [6]), 'length');
  assert.equal(pick(a, [3]) + pick(a, [14]) + pick(c, [18]) + pick(a, [2]) + pick(b, [18]) + pick(b, [16]) + pick(c, [0]) + pick(a, [4]) + pick(b, [0]) + pick(b, [15]), 'charCodeAt');
  assert.equal(pick(b, [21]) + pick(b, [6]) + pick(a, [17]) + pick(c, [5]), 'char');
  assert.equal(pick(b, [3]) + pick(a, [4]) + pick(b, [4]) + pick(a, [1]) + pick(c, [7]) + pick(c, [9]), 'length');
  assert.equal(pick(a, [9]) + pick(b, [3]) + pick(c, [20]) + pick(c, [17]) + pick(c, [13]), 'slice');
  assert.equal(c[7] + a[13] + a[20] + b[15] + a[2] + b[2] + c[15] + c[19], 'toString');

  // reference X(): hex of (char XOR key[i % key.length]) concatenated
  const reference = (text: string): string => {
    let out = '';
    for (let i = 0; i < text.length; i++) {
      const x = text.charCodeAt(i) ^ key.charCodeAt(i % key.length);
      const hex = x.toString(16);
      out += hex.length < 2 ? `0${hex}` : hex;
    }
    return out;
  };
  const ev = reference([1, 2, 0, 3, 4, '0', 300, 12, '00:05:00'].join(';'));
  assert.match(ev, /^[0-9a-f]+$/);
  assert.equal(reference(''), '');
  // the ported script carries exactly that algorithm
  assert.match(ZHIHUISHU_FORGE_JS, /KEY = 'zzpttjd'/);
  assert.match(ZHIHUISHU_FORGE_JS, /charCodeAt\(i\) \^ KEY\.charCodeAt\(i % KEY\.length\)/);
  assert.match(ZHIHUISHU_FORGE_JS, /parseInt\(String\(studyTotalTime \/ 5 \+ 2\), 10\)/);
  assert.match(ZHIHUISHU_FORGE_JS, /'0,1,'/);
  assert.match(ZHIHUISHU_FORGE_JS, /learning\/videolist/);
  assert.match(ZHIHUISHU_FORGE_JS, /prelearningNote/);
  assert.match(ZHIHUISHU_FORGE_JS, /PlayerStarter/);
  assert.match(ZHIHUISHU_FORGE_JS, /saveDatabaseIntervalTime/);
  assert.match(ZHIHUISHU_FORGE_JS, /btoa\(String\(note\.id\)\)/);
});

test('every forge script fails loudly instead of reporting invented state', () => {
  for (const [id, source] of [
    ['chaoxing-video', CHAOXING_FORGE_JS],
    ['zhihuishu', ZHIHUISHU_FORGE_JS],
  ] as const) {
    assert.match(source, /ok: false/, `${id} must be able to report failure`);
    assert.match(source, /detail: '/, `${id} must explain the failure`);
    // both build the request from captured state, never from a literal position
    assert.match(source, /__c4gForgePosition/);
  }
});

test('forge knowledge is validated: one of pattern/script/note, bounded script', () => {
  const withScript = parseSitePlugin({ ...plugin(), forge: { replayJs: "(() => ({ok:true}))()" } });
  assert.equal(withScript.forge?.replayJs, "(() => ({ok:true}))()");
  assert.throws(() => parseSitePlugin({ ...plugin(), forge: {} }), /needs timeFieldPattern, replayJs or note/);
  assert.throws(
    () => parseSitePlugin({ ...plugin(), forge: { replayJs: 'x'.repeat(16_385) } }),
    /exceeds 16384 bytes/,
  );
});

test('the catalog states each platform\'s forge situation', () => {
  // measured deployment: generic field rewrite
  assert.ok(LMS_FSRESOURCE_PLUGIN.forge?.timeFieldPattern);
  assert.equal(LMS_FSRESOURCE_PLUGIN.forge?.replayJs, undefined);
  // signed / obfuscated reports: platform script
  assert.ok(ZHIHUISHU_PLUGIN.forge?.replayJs);
  assert.ok(CHAOXING_PLUGIN.forge?.replayJs);
  // no forge knowledge at all → the gate refuses it by construction
  assert.equal(ICOURSE163_PLUGIN.forge, undefined);
});
