# DesktopCommanderMCP

## What This Is

Security-cleaned fork of DesktopCommanderMCP.

| | URL |
|---|---|
| Original | github.com/wonderwhy-er/DesktopCommanderMCP |
| Fork | github.com/themadsilversurfer-blip/DesktopCommanderMCP |
| Branch | `feature/security-clean-fork` |

## Security Changes Made (2026-03-15)

- Removed all telemetry (GA, BigQuery, postinstall tracking)
- Fixed prompt injection vectors (`[SYSTEM INSTRUCTION]` tags)
- Sanitized terminal output and PDF metadata
- Replaced `exec()` with `execFile()` in `feedback.ts`
- Replaced remote feature flags with local static config

## Custom Tools Added

### e2e_observer

5 modes for Belovy Trading System E2E testing:

| Mode | Description |
|------|-------------|
| `preflight_check` | Verify all prerequisites (CF Workers, VM processes, Bybit connectivity) |
| `start_observation` | Start 13 log streams (11 CF Workers + 2 VM processes) |
| `stop_observation` | Stop all streams |
| `get_log_summary` | Get logs with configurable filters |
| `trigger_test_signal` | Send test signal through the pipeline |

### Filter Modes

| Filter | Description |
|--------|-------------|
| `all` | Everything |
| `errors_only` | ERROR/WARN lines only |
| `trade_flow` | Complete signal path through all workers |
| `execution_vs_verify` | trade-maintainer vs. bybit-verification-worker |

### Usage

```bash
# 1. Preflight
e2e_observer preflight_check

# 2. Start observation (13 streams)
e2e_observer start_observation session_name duration_seconds

# 3. Send test signal
e2e_observer trigger_test_signal

# 4. Analyze
e2e_observer get_log_summary filter: execution_vs_verify

# 5. Stop
e2e_observer stop_observation
```

## Build & Run

```bash
npm run build
npm run start
```

## Git

```bash
git push myfork feature/security-clean-fork
```

## Key Files

| File | Purpose |
|------|---------|
| `src/tools/e2e-observer.ts` | E2E observer tool implementation |
| `src/tools/feedback.ts` | Sanitized feedback (execFile, not exec) |
| `config.json` | Local static config (replaces remote feature flags) |
| `SECURITY.md` | Security audit documentation |
