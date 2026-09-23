# M4 design: playback-rate exploration and the operator's rate choice

> Status: implemented (`packages/host/src/speed-probe.ts` + `packages/host/src/speed-policy.ts`).
> Prerequisites: README.md, packages/host/src/timekeeper.ts (rate guard and terminal-state rule), packages/host/src/platforms/plugin.ts (the plugin's credit fields), docs/m3-swarm.md (lane policy).

## 0. The problem

There are only two plausible ways an LMS can credit watch time, and they lead to opposite conclusions — so guessing is not an option:

| Backend implementation | Consequence of 2x |
|---|---|
| Credits the **reported position** (whatever the client claims) | A 60-minute video takes ≈30 minutes, credit still fills |
| Caps credit against the **real wall clock** (at most 1 credited second per wall second) | Credit is half the playback time and the risk is higher — strictly worse |
| Stops crediting once it **detects acceleration** | Credit stalls; stall self-recovery fires or the video is marked failed |
| Exposes **no readable credit field** | Undecidable by measurement, so the rate stays 1x |

So the first thing M4 does is not add a switch but a measurement. The read-only observation machinery the repo already has (the heartbeat hook that records requests and responses, `playerdata`, `totaltime`/`progress`) is exactly what the measurement needs.

## 1. Measurement method (speed-probe)

Two phases of `--window` seconds each (60s default, so ~2 minutes in total):

```
phase 1x: pin video.playbackRate to 1, sample the player state
phase R×: pin video.playbackRate to R, sample the player state
```

- Sampling: read `readPlayerState()` every 2s — that is the last heartbeat *response* the hook recorded, so `totaltime` / `progress` are server-acked values.
- Credit slope: use only the **first and last distinct heartbeat responses** in the window (`heartbeatTs` has to change to count as a new response), because re-reading a stalled response would masquerade as progress:
  `creditedPerWall = (totaltime_last − totaltime_first) / (heartbeatTs_last − heartbeatTs_first)/1000`, falling back to `progress/wall` when `totaltime` is absent.
- Client-side sanity check: `videoPerWall = ΔcurrentTime / Δwall` confirms the page really played at R.
- The probe only READS: it never synthesizes, replays or mutates a request, and it restores the rate to 1x when it finishes (unless `--keep-rate`).

Verdict (`computeVerdict`; thresholds are deliberately asymmetric):

| verdict | Condition (ratio = slope at R× ÷ slope at 1x) | Meaning |
|---|---|---|
| `credited` | ratio ≥ 0.9 × R | Acceleration is credited almost in full |
| `partial` | 1.2 < ratio < 0.9 × R | Acceleration works but is discounted (still better than 1x) |
| `wallclock` | ratio ≤ 1.2 | Wall-clock capped — speeding up costs risk and saves nothing |
| `stalled` | slope at R× ≤ 0.25 × slope at 1x | Accelerated playback stops being credited |
| `unobservable` | fewer than 2 heartbeats, or neither `totaltime` nor `progress`, or a 1x baseline below 0.5× | Not enough evidence; no verdict is invented |

## 2. The operator's choice and how it is gated

```sh
tsx src/index.ts speed-probe --url lms --rate 2 --window 60   # measure, write the policy file
tsx src/index.ts chain <courseUrl> --loop --rate 2            # batch at 2x
tsx src/index.ts chain <courseUrl> --loop --swarm 2 --rate 2  # lanes at 2x as well
```

Every supervising command accepts `--rate R` (0.25–4, default 1), `--rate-force` to override a refusal, and `--keep-rate` so the probe leaves the page accelerated. `decideRate()` reads `data/speed-policy.json` (per origin, fresh for 7 days):

| Policy state | What `--rate R` does |
|---|---|
| No entry | Runs an **inline probe** first (on the first queued video, ~2 minutes), then decides on the result |
| `credited` | Runs at R; the log states the measured credit rate |
| `partial` | Runs at R, but the log says "measured only 1.6×" |
| `wallclock` / `stalled` | **Falls back to 1x** with the reason; `--rate-force` overrides and the log marks it as an operator override |
| `unobservable` | Treated as no evidence (same as above) |
| Entry older than 7 days | Re-probed |

The policy file stores the evidence, not just the conclusion: verdict, ratio, measured slopes, heartbeat request/response excerpts and the measurement timestamp — so a verdict can be reviewed or overturned.

## 3. Runtime invariants

1. **Rate guard**: the `Timekeeper` pins the page to the rate it was configured with. Any drift (higher or lower) is undone; the host never invents a rate of its own — a source-guard test asserts that every `playbackRate` assignment references the configured value and that no literal above 1 appears.
2. **Tighter terminal-state rule**: at 1x the client clock is a faithful proxy (behaviour unchanged); **above 1x it is not** — a player that races to the end while the ledger lags is not "finished". Only the server's own ack (`progress ≥ 99` or `totaltime ≥ duration−3`) may close a video out, falling back to the client clock only when neither field is readable (so a run can never hang forever).
3. **Auditable accounting**: heartbeats stay read-only, and `WatchOutcome` carries `rate` plus wall seconds, so a report shows "900s of wall time at 2x" instead of hiding it.
4. Rate and concurrency are orthogonal: `--rate 2 --swarm 2` gives every lane the same gate and the same guard (the lane policy script takes the rate from that single decision).

## 4. Known limits

- The policy is remembered **per origin** only. If different courses or modules on one LMS behave differently, each needs its own measurement (the first `--rate` run checks the origin entry).
- Measurement needs a **playing video page**: `speed-probe` requires the current tab to be one; the inline probe uses the first queued video and aborts loudly when it is not playing.
- The probe itself consumes about two minutes of real viewing time (genuine playback, normally credited; the video is then supervised from the start, so no credited time is lost).
- Not done: per-video memory, an options-page UI switch (CLI only today), and automatic rate hunting under `partial` (e.g. trying 1.5x and 2x to find the best value).

## 5. Verification

```sh
pnpm -r build && pnpm -r typecheck && pnpm -r test
```

- `test/speed-probe.test.ts`: median and slope semantics (including "an unchanged heartbeat is not progress"), the `progress` fallback, the five-way verdict matrix, `measurePhase` with an injected clock (including no-video and paused aborts), end-to-end classification against three scripted backends (crediting, wall-clock, stalling), `--keep-rate`, and source guards (the probe issues no requests, always has a restore path, and never hard-codes a rate).
- `test/speed-policy.test.ts`: rate clamping, origin parsing, the store (round-trip, corruption tolerance, expiry) and the full `decideRate` matrix including overrides.
- `test/timekeeper.test.ts`: pinning the configured rate, undoing drift, writing no rate at 1x, and refusing to finish on the client clock alone above 1x.
