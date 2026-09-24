# chrome-extension-for-good (c4g)

Automation for Moodle-style course pages and study-time supervision, built as a CDP + Chrome-extension hybrid. The LMS video module ships as a **site plugin** (data, not code); other platforms are onboarded the same way, and the automatic inspect pipeline adapts to unfamiliar quiz pages.

## Architecture

```
┌─ packages/host (Node orchestration process, the brain) ─┐
│ cdp.ts        attach to a real Chrome (--remote-debugging-port) │
│ ws-server.ts  WebSocket bridge to the extension          │
│ jev.ts        TypeSafe Jev decision driver (table → action) │
│ solver.ts     LLM quiz solver (OpenAI-compatible)        │
│ quiz-loop.ts  quiz state machine                         │
│ timekeeper.ts playback supervisor (pins the configured rate, reads back credit) │
│ swarm.ts      concurrent lanes (chain --swarm N)          │
│ platforms/    site plugins (JSON) driving platform support │
└─────────────────────────────────────────────────────────┘
        │ WebSocket (snapshots / actions / events)   │ CDP (trusted input / evaluate)
┌─ packages/extension (MV3, resident eyes and hands) ─────┐
│ background.ts  WS client, webRequest heartbeat observation, tab open/close │
│ content.ts     element-table snapshots, action executor, quizSlot labels │
└─────────────────────────────────────────────────────────┘
        packages/protocol — wire contract shared by both ends (types + validators)
```

## Development

```sh
pnpm install
pnpm -r build          # run before building a package alone: protocol must emit dist first
pnpm -r typecheck
pnpm -r test
```

- Load the extension: Chrome → `chrome://extensions` → Developer mode → Load unpacked → select `packages/extension/dist`
- Start Chrome with the debug port: `open -a "Google Chrome" --args --remote-debugging-port=9222`
- Host: `cp .env.example .env`, fill in the keys, then `pnpm --filter @c4g/host dev` (without keys it runs in dry-run mode: decisions are logged, no external API is called)
- **Endpoint config is hot-reloadable from the extension**: the options page carries the quiz-LLM and TypeSafe (Jev) Base URL / API Key / Model; saving pushes it to the running host over `config_sync` (blank fields fall back to the `.env` defaults). Keys live only in local `chrome.storage.local` and are only sent to the host process over the loopback WebSocket; they are never logged.
- **Automatic inspect also consumes plugin knowledge**: a plugin may declare `quiz` (scope selector, question/option selectors, the platform's progress widget, button labels). The L1→L2→L3 layering and the conservation audit are unchanged; hints are additive and fall back on failure, and a distilled `data/recipes/<origin>.json` outranks the plugin's static seed. See `docs/m5-site-plugins.md` §7.
- **Overnight batching**: `pnpm --filter @c4g/host dev chain <courseUrl> --loop` rescrapes the course page after each drain and retries incomplete videos until everything is watched or `--max-passes N` (default 3) runs out; Ctrl-C persists the queue and ledgers before exiting. Retry counts live in `data/failed.json` (capped, so a run cannot loop forever).
- **Concurrent lanes (swarm)**: `... chain <courseUrl> --loop --swarm 2 [--swarm-mute] [--swarm-keep-tabs]` — each lane is one tab plus one Timekeeper running its own slice, sharing the completion ledger. See `docs/m3-swarm.md`.
- **Playback rate (measure, then choose)**: `speed-probe --url <video page> --rate 2 [--window 60]` measures whether the backend credits the reported position (1x baseline versus R×, ~2 minutes, read-only observation) and writes the verdict to `data/speed-policy.json`. `watch` / `chain` / `chain --swarm` then accept `--rate 2`: without a fresh measurement the host probes the first queued video inline, and a `wallclock`/`stalled` verdict falls back to 1x (`--rate-force` overrides). Details in `docs/m4-playback-rate.md`.
- **Report replay (instant-pass / accelerated reporting)**: `report-probe [--to-end] [--position N]` sends ONE replayed report (the platform's own recorded request with the position field rewritten, re-issued with the page's credentials) and judges it by the server's ack — `accepted` / `ignored` / `rejected` / `unobservable` — writing the verdict to `data/report-probe.json`. `--forge` then gates on it (`--forge-to-end` claims the whole duration per report); an `ignored` backend needs `--forge-force`, and the driver disables itself after 2 reports whose ack did not move. Details in `docs/m5-site-plugins.md` §6.
- **Stall self-recovery**: when server-credited time stalls during playback, the host first tries an in-page recovery (dismissing dialogs), then reloads the page and resumes real playback; up to 3 attempts per video, after which the video is marked failed and the next one starts. Every run ends with a per-video account (wall time / credited time / recoveries).

## Site plugins (platform plugins)

Platform support is not hard-coded: `packages/host/src/platforms/plugin.ts` defines the contract, and the built-in LMS adapter (`mod_fsresource`, measured on Sun Yat-sen University's deployment) is just a **built-in plugin JSON**. Any other platform is onboarded the same way.

```jsonc
{
  "id": "lms-fsresource",
  "label": "Moodle video module (mod_fsresource)",
  "match": { "video": "/mod/fsresource/view.php", "course": "/course/view.php" },
  "heartbeatUrlPattern": "mod_fsresource_set_time",
  "heartbeatHookJs": "(() => { /* MAIN world, idempotent: record the last heartbeat request/response on window.__c4gLastHeartbeat */ })()",
  "playerStateJs": "(() => ({ playing: …, currentTime: …, duration: …, rate: …, heartbeatTs: …, totaltime: …, progress: …, url: location.href }))()",
  "courseIdsJs": "(() => JSON.stringify([1,2,3]))()",
  "videoUrlTemplate": "/mod/fsresource/view.php?id={id}",
  "idPattern": "view\\.php\\?id=(\\d+)"
}
```

Field semantics and validation live in `packages/protocol/src/index.ts` (`SitePlugin` / `parseSitePlugin`): lengths, pattern compilability, the `{id}` placeholder and duplicate ids are all rejected at the contract layer.

**Sources and precedence** (a later source overrides an earlier one by `id`):

1. built-in plugins (`BUILTIN_PLUGINS` in the host);
2. `data/plugins/*.json` (local files, hand-editable);
3. **the extension options page "Site plugins" editor** (a JSON array) pushed to the running host — the everyday configuration path.

Matching: a tab URL containing `match.video` (or any entry of `match.videoAny`) is owned by that plugin; `match.course` / `match.courseAny` identifies the course page used for `chain` scraping. When nothing matches, `chain`/`watch` fail with an actionable error pointing at the options page, `data/plugins/`, or `inspect --learn`.

**Built-in catalog** (`verified` is true only for the adapter measured against a live account; the host says so in its log for the rest):

| id | Platform | Credit field | Notes |
|---|---|---|---|
| `lms-fsresource` | Moodle + `mod_fsresource` (target deployment) | `totaltime` | **verified**; URL-addressed, supports `chain` |
| `zhihuishu` | Zhihuishu / Zhidao | `studiedLessonDto.studyTotalTime` | derived; hash-routed SPA, `watch` only |
| `chaoxing-video` | Chaoxing / Xuexitong | — | derived; player lives in a same-tenant iframe, `watch` only |
| `icourse163` | China University MOOC | — | derived; hash-routed SPA, `watch` only |

The three derived entries transcribe URL/player/report facts from a public open-source implementation ([cxmooc-tools](https://github.com/CodFrm/cxmooc-tools)); `source` and `notes` state exactly what is unverified and which field to wire up next (steps in `docs/m5-site-plugins.md` §5.1).

Report replay (`forge`) knowledge is per platform as well: the LMS plugin ships a generic field-rewrite pattern (field name still to confirm), Chaoxing and Zhihuishu ship platform scripts (its MD5 is verified against `node:crypto`; the obfuscated encoder is pinned by a test that re-derives it), and icourse163 declares none, so the gate answers `no-pattern` rather than pretending.

## Data files (data/)

| File | Contents |
|---|---|
| `completions.json` / `failed.json` | completion ledger / retry counters (capped) |
| `queue.json`, `queue.laneN.json` | persisted queues (one per swarm lane) |
| `speed-policy.json` | measured playback-rate policy per origin (docs/m4-playback-rate.md) |
| `report-probe.json` | measured report-replay verdicts, per origin (docs/m5-site-plugins.md §6) |
| `swarm-flag.json` | evidence of a platform concurrency warning (docs/m3-swarm.md) |
| `corpus/<origin>/<captureId>.json` + `corpus/index.json` | page captures saved by `inspect` (docs/m2-auto-inspect.md §4.1) |
| `recipes/<origin>.json` | selectors distilled by `inspect --learn` |
| `plugins/*.json` | local site plugins |

## Design documents

- `docs/m2-auto-inspect.md` — automatic inspect pipeline (L1/L2/L3 + integrity mechanics)
- `docs/m3-swarm.md` — concurrent lanes
- `docs/m4-playback-rate.md` — playback-rate measurement and gating
- `docs/m5-site-plugins.md` — site plugins, report replay, inspect hints
