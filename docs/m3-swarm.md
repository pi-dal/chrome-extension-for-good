# M3 design: swarm lanes (concurrent videos)

> Status: implemented (`packages/host/src/swarm.ts`). This document is the single source of truth for the capability; where an implementation disagrees with it, this document wins.
> Prerequisites: README.md (M1 architecture), packages/host/src/timekeeper.ts (the single-video supervisor), packages/host/src/batch.ts (overnight batching and ledgers).

## 0. Goals and non-goals

**Goal**: `chain <courseUrl> --loop --swarm N` plays N videos **at the same time** in N tabs, with N Timekeepers supervising them and one shared completion ledger. Each video is still played at real time at the configured rate — no forged heartbeats, no seeking, no skipping ahead.

**Non-goals**:
- No multi-account / multi-profile expansion.
- No fighting the platform: when the platform raises an explicit warning, swarm degrades itself (see §4).

**Why it is worth having**: with one lane, total time = Σ video length; with N lanes the total is roughly the longest path, while the platform still validates credited time per resource against real wall-clock deltas. Swarm only changes *how many distinct resources are being watched at the same moment*; it does not invent time for any of them.

## 1. Lane model

| Piece | Description |
|---|---|
| Lane | One Chrome tab + one CDP connection + one `Timekeeper` + its own queue file `data/queue.<laneN>.json` |
| Scout | The tab the operator launched from. It only rescrapes the course page between passes and **never plays a video**, so planning can never navigate away from a lane that is mid-playback |
| Shared ledgers | `data/completions.json` / `data/failed.json` stay global across lanes (inserts happen before the write and the process is single-threaded, so nothing is lost) |
| Lane ceiling | `MAX_SWARM_LANES = 4`; `planSwarmLanes()` clamps the request and warns at ≥3 lanes |

## 2. Provisioning and attaching

1. `provisionLanes()` derives a unique marker per lane: `c4g_lane=<nonce>-<i>` (the nonce is per run, so a tab left over from a previous run can never be mistaken for ours).
2. It opens the tab through the extension's `open_tab` request (an additive protocol contract: `open_tab` → `tab_result`) to obtain the `chrome.tabs` id — that id is the only handle `snapshot_request`/`action_request` understand, and CDP alone cannot map a target back to it.
3. The lane's initial URL is the course page plus the marker, so `connectToMarker()` can match it **uniquely** in the CDP target list (two lanes never share a URL), retrying until the deadline.
4. A lane that fails to provision is dropped and the tab it just opened is closed again; only an all-fail outcome raises `no lane could be provisioned`. If the marker is lost (login/consent redirect), `connectToNewPage()` falls back to "the one page target that appeared since we opened the tab".

## 3. Lane keep-alive (making background tabs actually play)

Chrome throttles and freezes background tabs, and players often pause when they believe they are hidden or unfocused. Every lane therefore runs a policy (`applyLanePolicy`) after **every navigation**:

| Mechanism | Purpose |
|---|---|
| MAIN-world `laneKeepAliveScript` | Spoofs `document.hidden=false` / `visibilityState='visible'` / `hasFocus()=true`, defusing the player's visibility-pause logic |
| A held Web Lock (`c4g-swarm-<lane>`, unique per lane) | Chromium exempts lock-holding pages from intensive timer throttling (same-named locks queue, hence per-lane names) |
| `Page.addScriptToEvaluateOnNewDocument` | Puts the keep-alive script in place from the first line of JS in *future* documents (it must be registered before the first video document loads) |
| `Emulation.setFocusEmulationEnabled(true)` | Makes the page believe it is focused |
| `Page.setWebLifecycleState('active')` | Stops Chrome from freezing the tab |
| A `play()` nudge evaluated with `userGesture: true` | A freshly opened tab has no user activation, so `play()` would be rejected by autoplay policy; CDP's `Runtime.evaluate(userGesture=true)` attaches activation |
| `--swarm-mute` | Mutes the `<video>`. Cost: a muted tab loses the "audible page" throttling exemption, leaving the Web Lock and page lifecycle as the fallbacks |
| Rate pinning | The lane policy pins `playbackRate` to the rate this run decided (default 1); the rate gate lives in docs/m4-playback-rate.md, lanes only execute it |

A failing policy is logged (`timekeeper: lane page policy failed`) and never blocks supervision — that is the whole point of `TimekeeperDeps.onPageReady`, the single seam.

## 4. Platform signals and degradation (the core trade-off)

This deployment has previously answered concurrent playback with the text 「禁止同时观看多个视频」. Swarm treats that as a first-class input rather than hoping it stays away:

| Level | Pattern | Behaviour |
|---|---|---|
| HARD | 「禁止…同时/多个/多路…观看/播放」, 「不得/请勿/严禁/不能…同时观看」 | **Degrade immediately**: stand down every lane from the second on, set `activeLanes=1`, write the evidence to `data/swarm-flag.json`, and finish the remaining passes on a single lane |
| SOFT | generic 「同时观看/播放」, English concurrent / multiple videos | Log a `warn` only; course instructions routinely contain such wording, so it is not evidence |

Probe points (all read-only DOM text, ≤8KB):

1. **At each pass start** — one probe per active lane, catching a warning left over from an earlier pass or run;
2. **After every video** — one probe per lane, cheap and deterministic;
3. **A polling watchdog** (30s default) — covers a warning raised halfway through a 40-minute video.

A video that was in flight when degradation fired is **not counted as a retry attempt** (it is released from the `attempted` set and never charged to `failed.json`); the next pass hands it to a surviving lane.

## 5. Scheduling semantics

- **Splitting**: each pass distributes the planned queue round-robin (`splitIntoLanes()` → `[1,3,5]` / `[2,4]`), which balances uneven video lengths better than contiguous slices.
- **Per pass**: `planNextPass()` rescrapes the course page → drops credited and retry-exhausted videos → drops ids already watched in this run → splits → lanes run their slices concurrently (`Promise.all`).
- **`attempted` semantics**: an id is marked when its playback *starts*, not when it is planned. A video that never got its turn is therefore still retryable, while a video that was watched but did not reach a terminal state is never replayed within the same run.
- **Lane-death isolation**: if a lane's `watch()` throws (CDP gone, tab closed), that lane leaves the rotation for the rest of the run and its in-flight id is released for a surviving lane (an infrastructure failure is not a viewing attempt).
- **Graceful shutdown**: SIGINT / `run.stop()` stands every lane down and (unless `--swarm-keep-tabs`) closes the tabs this run created; interrupted videos are not written to the retry ledger either.

## 6. CLI

```sh
pnpm --filter @c4g/host dev chain <courseUrl> --loop --swarm 2            # two lanes
pnpm --filter @c4g/host dev chain <courseUrl> --loop --swarm 3 --swarm-mute
pnpm --filter @c4g/host dev chain <courseUrl> --loop --swarm 2 --swarm-keep-tabs --max-passes 3
```

- `--swarm N` requires `--loop` (it is a batch supervisor); `--swarm 1` is the original single-lane path and opens no extra tab.
- The run ends with one summary line: `swarm summary: 2 lane(s) (1 active), 12 watched, 12 completed, 0 failed`, plus `FLAGGED by platform on lane N` when it degraded.

## 7. Runtime invariants

- The default stays single-lane and sequential; concurrency is explicit (`--swarm N`), capped, monitored for platform signals, self-degrading, and leaves evidence behind.
- Every lane's playback rate comes from the single shared decision (docs/m4-playback-rate.md); a lane only pins the page to that rate.
- If the platform starts validating concurrency per account, the symptom is stalled credit → stall self-recovery fires → after 3 failed recoveries the video is marked failed and the next one starts; swarm never quietly assumes "watched".

## 8. Verification

```sh
pnpm -r build && pnpm -r typecheck && pnpm -r test
```

`packages/host/test/swarm.test.ts` covers: lane clamping, markers and park URLs, round-robin splitting, provisioning failures, keep-alive scripts and policy (userGesture / mute / rate guard), HARD and SOFT probes, closing half-built tabs, end-to-end scheduling (each video watched once, failure ledger, lane-death re-planning, no double start within a run, HARD degradation, watchdog degradation, graceful stop, kept tabs) and source guards (no HTTP requests, no `mod_fsresource_set_time`, `playbackRate` only ever set to the configured value).
