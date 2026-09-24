import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { LMS_FSRESOURCE_PLUGIN, parseSitePlugin, type SitePlugin } from '@c4g/protocol';
import type { LogFn } from '../src/log.js';
import { buildPlatform, coerceIdList, coercePlayerState, type PluginTab } from '../src/platforms/plugin.js';
import {
  loadPluginFiles,
  makeDynamicPlatform,
  mergePlugins,
  PlatformRegistry,
} from '../src/platforms/registry.js';

const tmp = mkdtempSync(join(tmpdir(), 'c4g-plugins-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

function logs(): { lines: string[]; log: LogFn } {
  const lines: string[] = [];
  const log: LogFn = (level, msg) => {
    lines.push(`${level}:${msg}`);
  };
  return { lines, log };
}

function plugin(over: Partial<SitePlugin> = {}): SitePlugin {
  return parseSitePlugin({
    id: 'demo',
    match: { video: '/watch/', course: '/catalog' },
    heartbeatHookJs: '(() => true)()',
    playerStateJs: '(() => "{}")()',
    videoUrlTemplate: '/watch/{id}',
    idPattern: '/watch/(\\d+)',
    ...over,
  });
}

/** A tab that answers probes from a scripted map, recording what was asked. */
function fakeTab(answers: Record<string, unknown>, url = 'https://demo.example/watch/7'): { tab: PluginTab; asked: string[]; setUrl(u: string): void } {
  const asked: string[] = [];
  let current = url;
  return {
    asked,
    setUrl: (u) => {
      current = u;
    },
    tab: {
      url: async () => current,
      navigate: async (u) => {
        current = u.startsWith('http') ? u : `https://demo.example${u}`;
      },
      evaluate: async <T,>(expression: string): Promise<T> => {
        asked.push(expression);
        if (!(expression in answers)) throw new Error(`unscripted probe: ${expression.slice(0, 40)}`);
        return answers[expression] as T;
      },
    },
  };
}

describe('buildPlatform', () => {
  it('turns plugin data into the adapter surface', async () => {
    const p = plugin({ courseIdsJs: 'IDS' });
    const adapter = buildPlatform(p);
    assert.equal(adapter.isVideoPage('https://demo.example/watch/7'), true);
    assert.equal(adapter.isVideoPage('https://demo.example/other'), false);
    assert.equal(adapter.isCoursePage('https://demo.example/catalog?x=1'), true);
    assert.equal(adapter.videoUrl(42), '/watch/42');
    assert.equal(adapter.videoUrl('42'), '/watch/42');
    assert.equal(adapter.idFromUrl('https://demo.example/watch/512?t=3'), 512);
    assert.equal(adapter.idFromUrl('https://demo.example/other'), null);
  });

  it('installs the plugin heartbeat hook and fails loudly when it does not take', async () => {
    const ok = fakeTab({ '(() => true)()': true });
    await buildPlatform(plugin()).installHeartbeatHook(ok.tab);
    assert.deepEqual(ok.asked, ['(() => true)()']);

    const bad = fakeTab({ '(() => true)()': false });
    await assert.rejects(buildPlatform(plugin()).installHeartbeatHook(bad.tab), /heartbeat hook did not install/);
  });

  it('reads player state from an object or a JSON string, rejecting junk', async () => {
    const asObject = fakeTab({ '(() => "{}")()': { playing: true, currentTime: 12.5, duration: 600, rate: 2, heartbeatTs: 7, totaltime: 10, progress: 40, url: 'u' } });
    const state = await buildPlatform(plugin()).readPlayerState(asObject.tab);
    assert.deepEqual(state, { playing: true, currentTime: 12.5, duration: 600, rate: 2, heartbeatTs: 7, totaltime: 10, progress: 40, url: 'u' });

    const asString = fakeTab({ '(() => "{}")()': JSON.stringify({ playing: false, currentTime: 1, duration: 2, rate: 1, heartbeatTs: 0, totaltime: null, progress: null }) });
    assert.equal((await buildPlatform(plugin()).readPlayerState(asString.tab)).playing, false);

    const junk = fakeTab({ '(() => "{}")()': 42 });
    await assert.rejects(buildPlatform(plugin()).readPlayerState(junk.tab), /must return an object or JSON string/);
  });

  it('scrapes course ids from an array or a JSON string, and refuses without a probe', async () => {
    const fromJson = fakeTab({ IDS: '[1, 2, "3", null, "x"]' });
    assert.deepEqual(await buildPlatform(plugin({ courseIdsJs: 'IDS' })).scrapeCourseVideoIds(fromJson.tab), [1, 2, 3]);

    const fromArray = fakeTab({ IDS: [9, 8] });
    assert.deepEqual(await buildPlatform(plugin({ courseIdsJs: 'IDS' })).scrapeCourseVideoIds(fromArray.tab), [9, 8]);

    await assert.rejects(buildPlatform(plugin()).scrapeCourseVideoIds(fromArray.tab), /no courseIdsJs/);
  });
});

describe('coercion helpers', () => {
  it('normalizes partial player state instead of trusting the page', () => {
    const state = coercePlayerState({ playing: 'yes', currentTime: 'x', rate: 0, totaltime: Number.NaN });
    assert.deepEqual(state, { playing: false, currentTime: 0, duration: 0, rate: 1, heartbeatTs: 0, totaltime: null, progress: null, url: '' });
    assert.throws(() => coercePlayerState('{oops'), /non-JSON string/);
    assert.deepEqual(coerceIdList('nonsense'), []);
    assert.deepEqual(coerceIdList('{"a":1}'), []);
  });
});

describe('mergePlugins', () => {
  it('lets later sources override an id while keeping order', () => {
    const builtin = plugin({ id: 'a' });
    const file = plugin({ id: 'a', label: 'from file' });
    const pushed = plugin({ id: 'b' });
    const merged = mergePlugins({ builtin: [builtin], files: [file], pushed: [pushed] });
    assert.deepEqual(merged.map((p) => p.id), ['a', 'b']);
    assert.equal(merged[0]!.label, 'from file');
  });
});

describe('loadPluginFiles', () => {
  it('loads valid JSON files, reports broken ones, and tolerates a missing dir', () => {
    const dir = join(tmp, `plugins-${Math.random().toString(36).slice(2)}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'good.json'), JSON.stringify(plugin({ id: 'good' })));
    writeFileSync(join(dir, 'list.json'), JSON.stringify([plugin({ id: 'x1' }), plugin({ id: 'x2' })]));
    writeFileSync(join(dir, 'bad.json'), '{ not json');
    writeFileSync(join(dir, 'invalid.json'), JSON.stringify({ id: 'no-match' }));
    const l = logs();
    const loaded = loadPluginFiles(dir, l.log).map((p) => p.id);
    assert.deepEqual(loaded.sort(), ['good', 'x1', 'x2']);
    assert.equal(l.lines.filter((line) => line.includes('ignoring')).length, 2);

    const l2 = logs();
    assert.deepEqual(loadPluginFiles(join(tmp, 'does-not-exist'), l2.log), []);
    assert.deepEqual(l2.lines, []);
  });
});

describe('PlatformRegistry', () => {
  it('matches the built-in LMS plugin and explains itself when nothing matches', () => {
    const l = logs();
    const registry = new PlatformRegistry(l.log);
    assert.equal(registry.forUrl('https://lms.example.com/mod/fsresource/view.php?id=1')?.plugin.id, 'lms-fsresource');
    assert.equal(registry.forCourseUrl('https://lms.example.com/course/view.php?id=42')?.plugin.id, 'lms-fsresource');
    assert.equal(registry.forUrl('https://example.com/anything'), null);
    assert.throws(() => registry.requireForUrl('https://example.com/anything'), /no site plugin matches.*Site plugins/s);
  });

  it('prefers a file plugin over the built-in of the same id, then a pushed one', () => {
    const l = logs();
    const registry = new PlatformRegistry(l.log);
    registry.useFilePlugins([plugin({ id: 'lms-fsresource', match: { video: '/file-version' } })]);
    assert.equal(registry.forUrl('https://x/file-version')?.plugin.id, 'lms-fsresource');
    assert.equal(registry.forUrl('https://lms.example.com/mod/fsresource/view.php?id=1'), null);

    registry.usePushedPlugins([plugin({ id: 'lms-fsresource', match: { video: '/pushed-version' } })]);
    assert.equal(registry.forUrl('https://x/pushed-version')?.plugin.id, 'lms-fsresource');
    assert.ok(l.lines.some((line) => line.includes('plugins updated from extension')));
  });

  it('adds a brand-new platform pushed from the extension', () => {
    const registry = new PlatformRegistry(() => {});
    registry.usePushedPlugins([plugin({ id: 'acme' })]);
    assert.equal(registry.forUrl('https://acme.example/watch/9')?.plugin.id, 'acme');
    assert.equal(registry.forCourseUrl('https://acme.example/catalog')?.plugin.id, 'acme');
    assert.deepEqual(
      registry.list().map((p) => p.id),
      ['lms-fsresource', 'zhihuishu', 'chaoxing-video', 'icourse163', 'acme'],
      'pushed plugins append to the built-in catalog',
    );
  });
});

describe('makeDynamicPlatform', () => {
  it('resolves the plugin per url so one supervisor can follow several platforms', async () => {
    const registry = new PlatformRegistry(() => {});
    registry.usePushedPlugins([plugin({ id: 'demo', courseIdsJs: 'IDS' })]);
    const platform = makeDynamicPlatform(registry, () => {});

    assert.equal(platform.isVideoPage('https://demo.example/watch/7'), true);
    assert.equal(platform.isCoursePage('https://demo.example/catalog'), true);
    assert.equal(platform.isVideoPage('https://nobody.example/lesson/1'), false);
    assert.equal(platform.isVideoPage(`${LMS_FSRESOURCE_PLUGIN.match.video}?id=1`), true, 'built-ins stay available');

    const demo = fakeTab({ '(() => "{}")()': { playing: true, currentTime: 5, duration: 100, rate: 1, heartbeatTs: 0, totaltime: 5, progress: 10 }, IDS: '[4,5]' });
    assert.equal((await platform.readPlayerState(demo.tab)).currentTime, 5);
    assert.deepEqual(await platform.scrapeCourseVideoIds(demo.tab), [4, 5]);
    assert.equal(platform.videoUrl(11), '/watch/11', 'videoUrl uses the plugin resolved from the tab url');
    assert.equal(platform.idFromUrl('https://demo.example/watch/11'), 11);

    // the LMS tab switches the platform under the same facade
    const lms = fakeTab({}, 'https://lms.example.com/mod/fsresource/view.php?id=77');
    await platform.readPlayerState(lms.tab).catch(() => {}); // resolves the LMS plugin, probe fails harmlessly
    assert.equal(platform.isVideoPage(await lms.tab.url()), true);
    assert.equal(
      platform.videoUrl(3),
      '/mod/fsresource/view.php?id=3',
      'videoUrl follows the most recently resolved plugin',
    );
    await platform.readPlayerState(demo.tab); // resolve demo again → it owns videoUrl once more
    assert.equal(platform.videoUrl(11), '/watch/11');
  });

  it('resolves through the COURSE matcher when the tab sits on a course page (scrape path)', async () => {
    // Regression: resolve() used requireForUrl (video matcher only), so
    // scrapeCourseVideoIds on a course page threw 'no site plugin matches' —
    // the whole chain/loop/swarm scrape path was dead on real course pages.
    const registry = new PlatformRegistry(() => {});
    registry.usePushedPlugins([plugin({ id: 'demo', courseIdsJs: 'IDS' })]);
    const platform = makeDynamicPlatform(registry, () => {});
    const courseTab = fakeTab({ IDS: '[7, 8]' }, 'https://demo.example/catalog');
    assert.deepEqual(await platform.scrapeCourseVideoIds(courseTab.tab), [7, 8]);
    assert.equal(platform.videoUrl(3), '/watch/3', 'course-page resolve warms the same plugin for videoUrl');
  });

  it('reports heartbeat patterns from the plugin that owns the current page', async () => {
    const registry = new PlatformRegistry(() => {});
    const platform = makeDynamicPlatform(registry, () => {});
    assert.equal(platform.heartbeatUrlPattern, undefined);
    const lms = fakeTab({ '(() => true)()': true }, 'https://lms.example.com/mod/fsresource/view.php?id=5');
    // installHeartbeatHook reads the url first, which warms the adapter
    const registryTab = {
      ...lms.tab,
      evaluate: async <T,>() => {
        throw new Error('hook not needed in this test');
      },
    };
    await platform.installHeartbeatHook(registryTab).catch(() => {});
    assert.equal(platform.heartbeatUrlPattern, 'mod_fsresource_set_time');
  });
});

describe('built-in catalog through the host layer', () => {
  it('matches every built-in platform, including alternative player urls', () => {
    const registry = new PlatformRegistry(() => {});
    assert.equal(registry.forUrl('https://lms.example.com/mod/fsresource/view.php?id=9')?.plugin.id, 'lms-fsresource');
    assert.equal(registry.forUrl('https://studyh5.zhihuishu.com/videoStudy.html#/studyVideo?x=1')?.plugin.id, 'zhihuishu');
    assert.equal(registry.forUrl('https://mooc1.chaoxing.com/ananas/modules/video/index.html?objectId=1')?.plugin.id, 'chaoxing-video');
    assert.equal(registry.forUrl('https://www.icourse163.org/learn/SYSU-100?tid=1')?.plugin.id, 'icourse163');
    // the /spoc/learn/ variant only matches because videoAny is consulted
    assert.equal(registry.forUrl('https://www.icourse163.org/spoc/learn/SYSU-200')?.plugin.id, 'icourse163');
  });

  it('declares a heartbeat pattern only where the heartbeat is actually known', () => {
    const registry = new PlatformRegistry(() => {});
    const patternOf = (url: string): string | undefined => registry.requireForUrl(url).heartbeatUrlPattern;
    assert.equal(patternOf('https://lms.example.com/mod/fsresource/view.php?id=1'), 'mod_fsresource_set_time');
    assert.equal(patternOf('https://studyh5.zhihuishu.com/videoStudy.html'), 'saveDatabaseIntervalTime');
    // undefined on purpose where the credit field is unknown: the generic
    // frequency observer runs and reports a candidate instead of pretending
    assert.equal(patternOf('https://mooc1.chaoxing.com/ananas/modules/video/index.html'), undefined);
    assert.equal(patternOf('https://www.icourse163.org/learn/SYSU-100'), undefined);
  });

  it('says out loud when a plugin is not verified against a live account', () => {
    const l = logs();
    const registry = new PlatformRegistry(l.log);
    registry.forUrl('https://studyh5.zhihuishu.com/videoStudy.html');
    assert.ok(
      l.lines.some((line) => line.includes('zhihuishu') && line.includes('NOT verified') && line.includes('cxmooc-tools')),
      l.lines.join('\n'),
    );
    // the measured adapter is not smeared with the same warning
    registry.forUrl('https://lms.example.com/mod/fsresource/view.php?id=1');
    assert.ok(l.lines.some((line) => line.includes('lms-fsresource (verified)')));
  });
});
