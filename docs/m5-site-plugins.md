# M5 design: site plugins (platform adapters as data)

> Status: implemented. The contract lives in `packages/protocol/src/index.ts` (`SitePlugin` / `parseSitePlugin`), the built-in plugins in `packages/protocol/src/plugins/`, the host assembly in `packages/host/src/platforms/{plugin,registry}.ts`, and the configuration entry point in the extension options page (`packages/extension/src/options.ts`).
> Prerequisites: README.md, packages/host/src/timekeeper.ts (who calls these probes), docs/m2-auto-inspect.md (the inspect pipeline plugins feed hints to).

## 0. Goal

Platform support stops being hard-coded: the built-in LMS adapter (`mod_fsresource`) is just the first plugin in a catalog, any other platform is onboarded as JSON, and the configuration path is the **extension options page** (saved plugins take effect live). The host platform layer is left with three jobs: pick the plugin by URL, run the probes the plugin supplies, and normalize what comes back.

## 1. Contract

```ts
interface SitePlugin {
  id: string;                      // [A-Za-z0-9._-]+, ≤64B; same id → later source wins
  label?: string;                  // display name
  match: {                         // URL-substring matching
    video: string; videoAny?: string[];      // platforms with several player URLs
    course?: string; courseAny?: string[];
    quiz?: string; quizAny?: string[];       // quiz/attempt pages → quiz hints apply there
  };
  heartbeatUrlPattern?: string;    // known heartbeat fragment → fast path, skips generic detection
  heartbeatHookJs: string;         // MAIN world, idempotent: record the last heartbeat request/response
  playerStateJs: string;           // MAIN world: player state object (or its JSON string)
  courseIdsJs?: string;            // MAIN world: course-page video id array (or JSON string)
  videoUrlTemplate?: string;       // must contain {id}
  idPattern?: string;              // regex with one capture group, video id from a video URL
  source?: string;                 // where this definition came from (repo/URL/measurement notes)
  notes?: string;                  // what is unverified, what to wire up next
  verified?: boolean;              // true only when measured against a live account
  forge?: {                        // report replay (instant-pass / accelerated reporting)
    timeFieldPattern?: string;     // regex for the position field in the recorded report body
    replayJs?: string;             // platform replay script for signed/obfuscated bodies
    note?: string;
  };
  quiz?: {                         // automatic-inspect knowledge
    rootSelector?: string;         // narrow candidate scanning to this subtree
    questionSelector?: string;     // one question container
    optionSelector?: string;       // one option row
    progressSelector?: string;     // the platform's own progress/time widget
    navLabels?: string[];          // check/save/next/submit button texts
    source?: string; notes?: string; verified?: boolean;
  };
}
```

Validation rules (enforced by the shared protocol parser, used by both the extension and the host):

| Item | Rule |
|---|---|
| Count | ≤16 plugins per sync |
| JS fields | each ≤16KB; `label` ≤128B; match/pattern fields ≤256B (`videoUrlTemplate` ≤512B); total ≤256KB |
| `idPattern` | must compile and contain a capture group |
| `videoUrlTemplate` | must contain `{id}` |
| `match.videoAny` / `courseAny` / `quizAny` | non-empty array, ≤256B each, ≤8 entries |
| `forge` | needs at least one of `timeFieldPattern`, `replayJs`, `note`; `replayJs` ≤16KB |
| `forge.timeFieldPattern` | must compile as a RegExp |
| `quiz` | must not be empty; `navLabels` non-empty, ≤8 entries, ≤64B each |
| `source` / `notes` | ≤512B; tests assert the built-in catalog carries both (provenance discipline) |
| `verified` | boolean; only a measured adapter may claim true |
| Duplicate ids | the whole list is rejected (no ambiguity about which one wins) |

`playerStateJs` returns (see `coercePlayerState` in `packages/host/src/platforms/plugin.ts`): `{ playing, currentTime, duration, rate, heartbeatTs, totaltime, progress, url }`. Missing fields are normalized safely (`rate` ≤ 0 → 1, `totaltime`/`progress` absent → null = unreadable); a non-object, non-JSON-string result is an error.

## 2. Sources and precedence

```
built-in BUILTIN_PLUGINS  <  data/plugins/*.json  <  extension options page push (plugins_sync)
```

- Same `id` overrides, a different `id` appends, and order is stable (useful for logs and for the `Known: [...]` hint in errors).
- A `data/plugins/*.json` file may hold one plugin object or an array; a broken file is logged and skipped.
- The extension pushes a full-state sync: the service worker validates with the protocol parser first and simply **does not push** an invalid list (logging a warning to the host), so the host keeps its last working set.

## 3. Runtime behaviour

| Situation | Behaviour |
|---|---|
| Picking a plugin | `registry.forUrl(url)` (video page) / `forCourseUrl(url)` (course page), matched by substring |
| No plugin matches | `requireForUrl()` throws an actionable error: add one in the options page, drop a file into `data/plugins/`, or run `inspect --learn`; it lists the known plugins |
| One supervisor across platforms | `makeDynamicPlatform()` resolves the plugin from the tab's CURRENT url on every call, so a single `chain` queue may span platforms |
| `videoUrl` / `idFromUrl` / `heartbeatUrlPattern` | These carry no URL, so they read the most recently resolved adapter. `tick()` reads the URL before it needs them, so the value is always warm |
| Adapter cache | Cached per plugin id; swapping the plugin set (push or file change) clears the cache |
| Unverified plugin | The host logs `platform: using <id> — NOT verified against a live account (source: …) · <notes>` the first time it builds that adapter |

## 4. Writing a new plugin

1. **Find the match strings**: a stable fragment of the video-page URL (e.g. `/lesson/`) and, optionally, of the course/list page.
2. **Observe the heartbeat**: locate the "report progress" request in DevTools → Network. Copy `LMS_FSRESOURCE_PLUGIN.heartbeatHookJs` and adapt it: point `MATCH` at your fragment and record `{ts, url, requestBody, responseText}` on `window.__c4gLastHeartbeat`.
3. **Read the player**: `playerStateJs` reads `paused/currentTime/duration/playbackRate` from the `video` element and extracts `totaltime`/`progress` from the heartbeat response (server-acked fields — the rate verdict depends on them, see docs/m4-playback-rate.md).
4. **Course ids** (optional): `courseIdsJs` returns a deduplicated array of the video ids on the page.
5. **URL template and id regex**: `videoUrlTemplate: '/lesson/{id}'`, `idPattern: '/lesson/(\\d+)'`.
6. Paste the JSON into the extension options page → Validate → Save. The host logs `platform: plugins updated from extension → [...]`.
7. Run `speed-probe --url <video page>` to confirm heartbeats are readable (`heartbeats` ≠ 0), then `watch` / `chain`.

## 5. Built-in catalog

| id | Platform | video match | credit field | URL-addressed queue | Status |
|---|---|---|---|---|---|
| `lms-fsresource` | Moodle + `mod_fsresource` (this repo's target deployment) | `/mod/fsresource/view.php` | `"totaltime"` in the heartbeat response | yes — template + `idPattern` + course scraping | **verified** (live account) |
| `zhihuishu` | Zhihuishu / Zhidao | `studyh5.zhihuishu.com/videoStudy.html` | `studiedLessonDto.studyTotalTime` | no — hash-routed SPA with an in-page playlist | derived from cxmooc-tools |
| `chaoxing-video` | Chaoxing / Xuexitong | `ananas/modules/video/index.html` | none (`isPassed` is a boolean) | no — the player lives in a same-tenant iframe | derived from cxmooc-tools |
| `icourse163` | China University MOOC | `icourse163.org/learn/` + `/spoc/learn/` | none (no cumulative field identified yet) | no — hash-routed SPA | derived from cxmooc-tools |

Design decisions worth stating, all driven by how the platforms actually look:

- **`heartbeatUrlPattern` is declared only where the credit field is also parseable.** Declaring it makes the `Timekeeper` skip generic heartbeat observation (the "observed a POST /api/progress every 15s" log line); for Chaoxing and icourse163, where no cumulative field has been identified, keeping observation is more useful — operators use it to learn the cadence before wiring the hook.
- **Platforms without URL addressing support `watch` only, not `chain`.** Queue scheduling assumes "one video page = one URL + one resource id"; hash-routed SPAs (Zhihuishu, icourse163) and iframe players (Chaoxing) do not satisfy that. Supporting them needs in-page navigation plus reading inside the player context — future work.
- **Derived plugins never claim verification**: `verified` is true only for `lms-fsresource`, and the host says so in its log.

### 5.1 Verifying a derived plugin (recommended order)

1. `pnpm --filter @c4g/host dev speed-probe --url <video page>`: an `unobservable` verdict means the credit field is not being read yet — exactly what the plugin's `notes` says. Start in DevTools → Network and find the report response.
2. Once you have the cumulative field, adapt `heartbeatHookJs` (swap the regex for your field) and `playerStateJs`'s `totaltime`/`progress`, paste it back in the options page and save.
3. Re-run `speed-probe`: only after a measured `credited` / `wallclock` / `stalled` verdict does `--rate` act on evidence (docs/m4-playback-rate.md).
4. Leave `verified` false, and update `source`/`notes` with what you measured (or ship it as a local `data/plugins/*.json` override).
5. To probe report replay: run `report-probe` (one request) and read the verdict before deciding on `--forge`; when the platform script lacks captured state it names the missing piece (e.g. `player params not captured yet`).

## 6. Report replay (instant-pass / accelerated reporting)

The mechanism exists once, in `packages/host/src/forge.ts`:

1. The plugin's hook already recorded the platform's **own** report request in `window.__c4gLastHeartbeat` (`{ts, url, requestBody, responseText}`);
2. Replay takes that record, rewrites the position field using the plugin's `forge.timeFieldPattern` (or hands the whole job to the plugin's `forge.replayJs` when the body is signed/obfuscated), and re-issues it to the same URL from inside the page with the page's own credentials;
3. Judgement compares the **server's own ack** (`totaltime`/`progress`) before and after, not the HTTP status.

### 6.1 Measure first (the same discipline as the rate gate)

```
report-probe [--url SUBSTR] [--to-end] [--position SECONDS]   # one report, judged by the server ack
--forge [--forge-to-end] [--forge-step N] [--forge-stalls N] [--forge-force]   # on any supervising command
```

| Verdict | Meaning | Consequence |
|---|---|---|
| `accepted` | the ack moved | `--forge` is allowed |
| `ignored` | HTTP succeeded but the ack did not move (wall-clock-capped backend) | refused by default (`--forge-force` overrides) |
| `rejected` | the replay itself was refused | same as above |
| `unobservable` | no readable ack (the platform exposes no cumulative field) | same as above; without an ack nothing can be verified |

**On this repo's target deployment the expected verdict is `ignored`**: the backend returns its own `totaltime` in the heartbeat response and the historical evidence says it caps credit against the wall clock. `report-probe` is what turns that assumption into a conclusion — an `accepted` verdict would mean the backend really does trust client-reported positions, and only then is `--forge` meaningful.

### 6.1.1 Per-platform replay knowledge

| Plugin | Replay kind | Captured state it needs | Unit-level verification |
|---|---|---|---|
| `lms-fsresource` | Generic rewrite (`forge.timeFieldPattern`): patch the position field in the recorded body and re-send it | `__c4gLastHeartbeat.url/requestBody` from the hook | field name still to be confirmed against a real body (one regex line) |
| `chaoxing-video` | Platform script (`forge.replayJs`): re-sign and re-send `enc = md5('[clazzId][userid][jobid][objectId][playTime*1000][d_yHJ!$pdA~5][duration*1000][0_duration]')`, GET `reportUrl/dtoken?...&playingTime=&isdrag=4&enc=` | `__c4gCx.params` (the hook wraps `ans.VideoJs.prototype.params2VideoOpt`) | **MD5 verified against `node:crypto`** over multiple vectors including non-ASCII (UTF-8) input; the salt and URL shape come from the referenced implementation |
| `zhihuishu` | Platform script: recompute the signed body (obfuscated `ev` encoder + `watchPoint` chain) and POST `saveDatabaseIntervalTime` | `videoList`, `studiedLessonDto`, `nowVideoId`, the current lesson (`.current_play .hour`) and its duration text | **the encoder algorithm is pinned by a test** that re-derives `length/charCodeAt/slice/toString` from the reference implementation's own lookup tables, proving the ported algorithm is the original one |
| `icourse163` | none | — | the gate answers `no-pattern`; it does not pretend to support it |

Both platform scripts are **behaviour-equivalent ports**, not "a request that looks about right": the `ev` encoder and MD5 are both covered by tests (see the table), and when the captured state is missing the script fails explicitly (`lecture list not captured yet` and similar) instead of sending invented data.

### 6.2 The driver stands itself down

`makeForgeDriver` sends at most one replay per tick and **disables itself** after `--forge-stalls` (default 2) reports whose ack did not move, writing the conclusion back into `data/report-probe.json` (`source: 'driver'`) — so the next run reads the evidence from the gate instead of hammering a backend that does not honour replays.

### 6.3 Integrity invariants

- **The completion rule is unchanged**: a video counts as finished only when the server's own ack confirms it (`progress ≥ 99` or `totaltime ≥ duration−3`), and above 1x only the server counts. The replay driver never writes to the ledger.
- The worst case of "the replay is ignored" is therefore a handful of wasted requests — never an account where the ledger says "watched" and the platform says otherwise.
- Per-platform `forge` knowledge lives in plugin data; the gate reads it to answer `no-pattern` / allow / refuse, so changing strategy is a field edit rather than a host code change.

## 7. Automatic inspect and plugins

Automatic inspect (M2: capture → L1 recipe / L2 heuristics / L3 LLM → Jev arbitration → conservation audit) is platform-agnostic already. Plugins do not replace it; they add the part the platform itself knows, and every addition is optional:

| Plugin field | Effect | On failure |
|---|---|---|
| `quiz.rootSelector` | Narrows candidate scanning to that subtree with a snapshot probe (less noise from course navigation, sidebars, forums) | Probe fails or matches nothing → **the full page is kept** and the log says so |
| `quiz.navLabels` | Adds nav indices by the platform's button texts (check/save/next/submit) | No match → the result is untouched |
| `quiz.questionSelector` / `optionSelector` | Used by L1 recipe confirmation and distillation (same selector grammar) and passed to L3 as **platform context** | Confirmation failure → falls back to L2 (existing behaviour) |
| `quiz.progressSelector` | Reads the platform's own progress widget when the capture produced no `progressClaim` | Unreadable → no claim is set |

Layering (first hit wins, top to bottom):

```
data/recipes/<origin>.json  (measured distillation; only counts after L1 confirmation)
        ↓
plugin quiz hints  (static seed: scope narrowing + button texts + context)
        ↓
L2 structural heuristics  (unchanged)
        ↓
L3 LLM enumeration (prompt carries the plugin hints) + Jev arbitration + conservation audit (unchanged)
```

**The conservation audit is not relaxed**: even when a plugin selector matches, element ownership still has to pass `conservation`; with `rootSelector` the audit runs on the narrowed table, and the narrowing itself is recorded in diagnostics so it can be reviewed.

### 7.1 A real bug this integration flushed out (fixed)

Wiring `rootSelector` exposed this: the two probe builders wrapped their result in `JSON.stringify`, while the extension side (`content.ts`) already serializes whatever the page returns. The host therefore received the strings `"3"` / `"[1,0,1]"` while every consumer compared numbers and arrays:

- `confirmRecipe`'s `Array.isArray(flags)` was always false → **L1 recipe confirmation could never succeed in production**;
- `distill`/`recipes` compared `"2" !== 2` → **selector distillation produced nothing**, so `inspect --learn` was effectively a no-op.

The builders now return raw values (a number and an array), the contract is documented in both files, and the old test that had enshrined the misunderstanding was corrected. Two regression tests evaluate the generated expressions in a `new Function` sandbox and assert `typeof === 'number'` / `Array.isArray(...) === true`, then push them through `JSON.parse(JSON.stringify(v))` to mirror the real transport. The L1 design in docs/m2-auto-inspect.md is, for the first time, true on the live path.

### 7.2 Per-platform inspect knowledge today

| Plugin | quiz knowledge | Basis |
|---|---|---|
| `lms-fsresource` | `progressSelector: '.num-bfjd span'` plus a set of Chinese button labels | sysu-lms field notes; **no question/option selector is invented** — those come from `inspect --learn` |
| `icourse163` | `questionSelector: '.u-questionItem'`, `optionSelector: '.u-tbl.f-pr.f-cb'` | cxmooc-tools `src/mooc/course163/question.ts` (the same file also gives `input[type=radio|checkbox]`, `textarea` and `.u-icon-correct` markers) |
| `zhihuishu` | `navLabels` only | the exam DOM was not transcribed (the reference keeps it in `exam.ts`), so no selector is invented |
| `chaoxing-video` | none | same reasoning (reference `question.ts`); `notes` points at `inspect --learn` |

Selectors learned by `inspect --learn` still land in `data/recipes/<origin>.json` and take precedence over the plugin's static seed — measured beats static beats guessed (which does not exist).

## 8. Verification

```sh
pnpm -r build && pnpm -r typecheck && pnpm -r test
```

- `packages/protocol/test/plugins.test.ts`: the built-in LMS plugin and its key fields, `idPattern` actually extracting an id, a minimal plugin, eleven classes of invalid input, list-level limits (duplicate ids / count / type), `plugins_sync` round-trip, a plugin describing a different platform, **catalog integrity** (unique ids, label/source/notes present, `verified` boolean, `videoUrlTemplate` + `idPattern` round-tripping), **only the measured adapter claims verification**, **derived adapters state their limits in notes**, `match.videoAny` validation, provenance field bounds, and the two replay scripts (MD5 versus `node:crypto`, encoder derivation).
- `packages/host/test/forge.test.ts`: the replay script (position rewrite, reusing the recorded URL, never hard-coding a host), honest failures for a missing heartbeat / missing field / HTTP error, the four verdicts, the evidence store, the gate matrix including overrides, the driver (counting acked reports, `--forge-to-end` claiming the full duration, self-disabling after stalls and recording the verdict, refused replays counting as stalls), `forgeSummaryLine`, and validation of the plugins' forge declarations.
- `packages/host/test/inspect/plugin-hints.test.ts`: scope narrowing (hit / zero hits / probe error / grammar-unsafe selector all keep the full page), nav labels (case and whitespace normalization, disabled elements excluded, additive and deduped, sorted output), the progress-widget fallback, the hint summary line, plus a regression on the **probe value types** (number/array, still number/array after the transport round-trip).
- `packages/host/test/platforms.test.ts`: `buildPlatform` (hook install failure, both player-state shapes, junk rejection, course-id parsing, template and regex), `coercePlayerState` defaults, `mergePlugins` precedence, `loadPluginFiles` (good / broken / missing directory), `PlatformRegistry` (built-in match, file override, pushed override, new platform, actionable error when nothing matches) and `makeDynamicPlatform` (per-URL switching, `videoUrl` following the last resolution, heartbeat pattern from the page's own plugin).
