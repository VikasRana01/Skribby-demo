# Skribby demo — task list: bot lifecycle → recording → download → transcription

Use this as a checklist for implementation verification and R&D. Order matches the intended runtime flow.

---

## Phase A — Bot creation & join

| # | Task | Status | Notes |
|---|------|--------|--------|
| A1 | Create bot via `POST /bot` with `meeting_url`, `service: zoom`, `transcription_model` (required by Skribby API) | ☐ | `skribbyService.createBot` |
| A2 | Optionally set `webhook_url` from `SKRIBBY_WEBHOOK_BASE` | ☐ | Many dashboards have no “Add webhook” UI; URL is per-bot on create |
| A3 | Persist `bot_sessions` row with `bot_id`, user, meeting metadata | ☐ | DB insert after Skribby returns id |
| A4 | **R&D:** Confirm minimum / cheapest `transcription_model` if you only use **recording + external STT** | ☐ | Billing & model list on Skribby; API still requires a model |

---

## Phase B — In-meeting & status progression (Skribby)

Track how Skribby moves through states (from docs / observed behavior).

| # | Task | Status | Notes |
|---|------|--------|--------|
| B1 | Map Skribby statuses → app `bot_sessions.status` / `provider_status` | ☐ | `skribbyLifecycle.applySkribbyStatusUpdate` |
| B2 | Handle `joining` / `booting` → local “joining” | ☐ | Webhook `status_update` + poller `GET /bot` |
| B3 | Handle `recording` → local “in_call” | ☐ | |
| B4 | Handle `processing` / `transcribing` / `leaving` → appropriate local state | ☐ | |
| B5 | **R&D:** Document exact order of states for Zoom on your plan (any extra states?) | ☐ | [Bot lifecycle](https://skribby.io/docs/guides/bot-lifecycle) |
| B6 | **R&D:** Whether `stop_reason` is always present when `finished` / `not_admitted` | ☐ | Affects `provider_status` string format |

---

## Phase C — Webhook flow (Skribby → your app)

| # | Task | Status | Notes |
|---|------|--------|--------|
| C1 | Expose `POST /api/webhook/skribby` (HTTPS in prod / tunnel in dev) | ☐ | `src/routes/webhook.js` |
| C2 | Verify `X-Skribby-Signature` + `X-Skribby-Timestamp` when `SKRIBBY_WEBHOOK_SECRET` set | ☐ | Raw body required — `server.js` `express.json({ verify })` |
| C3 | Parse `type: "status_update"` and read `data.new_status`, `data.stop_reason` | ☐ | |
| C4 | Return `200` quickly; run heavy work after response | ☐ | |
| C5 | **R&D:** Confirm whether all plans deliver webhooks when `webhook_url` is set on Create Bot | ☐ | If not, rely on polling |
| C6 | **R&D:** Retry / deduplication policy if Skribby resends the same `status_update` | ☐ | Current: idempotency via `provider_status` match |

---

## Phase D — Polling fallback (when webhooks missing or delayed)

| # | Task | Status | Notes |
|---|------|--------|--------|
| D1 | Poll `GET /bot/{id}` for sessions not `done`/`failed` (e.g. last 72h) | ☐ | `skribbyPollService.js` |
| D2 | Tune `SKRIBBY_POLL_INTERVAL_MS` / `SKRIBBY_POLL_ENABLED` | ☐ | |
| D3 | **R&D:** Rate limits vs poll interval for your Skribby tier | ☐ | Avoid 429s |

---

## Phase E — Recording done → `recording_url` available

| # | Task | Status | Notes |
|---|------|--------|--------|
| E1 | On Skribby `finished` (webhook or poll), update DB and schedule post-meeting pipeline | ☐ | `schedulePostMeetingPipeline` (+ 8s delay) |
| E2 | **In progress (app):** `resolveRecordingUrl` — retry `GET /bot` until `recording_url` or max attempts | ☐ | `RECORDING_URL_MAX_ATTEMPTS`, `RECORDING_URL_RETRY_MS` |
| E3 | **R&D:** Time from `finished` to non-null `recording_url` (p50/p95) on your account | ☐ | Drives retry count / delay |
| E4 | **R&D:** Does `recording_url` require extra auth headers or is it fully signed/public? | ☐ | Affects `transcriptionService.downloadFile` |
| E5 | **R&D:** Expiry / `recording_available_until` — download before deletion | ☐ | Skribby bot object fields |

---

## Phase F — Download audio (in progress)

| # | Task | Status | Notes |
|---|------|--------|--------|
| F1 | Stream URL to temp file with size limit (`TRANSCRIPTION_MAX_FILE_MB`) | ☐ | `transcriptionService` |
| F2 | **R&D:** Large meetings &gt; Whisper limit — chunking, or another STT provider | ☐ | OpenAI Whisper ~25MB typical cap |
| F3 | **R&D:** Correct file extension / content-type for your recordings | ☐ | URL may be `.mp4` etc. |

---

## Phase G — Transcription (your model / your API key)

| # | Task | Status | Notes |
|---|------|--------|--------|
| G1 | `POST_MEETING_TRANSCRIPT_SOURCE=recording_openai_whisper` — skip Skribby transcript segments | ☐ | Default path |
| G2 | Configure `TRANSCRIPTION_OPENAI_*` / `OPENAI_API_KEY` + optional base URL | ☐ | |
| G3 | Optional: `recording_custom_http` + `TRANSCRIPTION_HTTP_*` | ☐ | Multipart POST |
| G4 | **R&D:** Validate custom endpoint response shape (`text` / `transcript` / raw) | ☐ | Adjust parsing if needed |
| G5 | **R&D:** Latency and timeouts for long audio | ☐ | `axios` timeout in `transcriptionService` |

---

## Phase H — Summary & storage (optional)

| # | Task | Status | Notes |
|---|------|--------|--------|
| H1 | Save transcript on `bot_sessions` | ☐ | |
| H2 | If `SUMMARY_AFTER_TRANSCRIPTION=true`, run `SUMMARY_MODEL` via `SUMMARY_OPENAI_*` | ☐ | |
| H3 | If summaries off, ensure poller does not infinite-loop “finished” | ☐ | `hasPostMeetingWorkPending` + `SUMMARY_AFTER_TRANSCRIPTION` |

---

## Phase I — Ops & observability

| # | Task | Status | Notes |
|---|------|--------|--------|
| I1 | Log lines: webhook received, poll tick, recording wait attempt, download start, STT start, summary start | ☐ | grep-friendly |
| I2 | `/health` shows transcript mode + summary flag | ☐ | `server.js` |
| I3 | **R&D:** Structured logging / correlation id = `bot_id` | ☐ | For production |

---

## Quick “definition of done” for one meeting

1. Bot reaches Skribby `finished` (seen via webhook or poll).  
2. `recording_url` appears and audio downloads successfully.  
3. Your STT returns non-empty text.  
4. Transcript stored; if enabled, summary row `completed`.  
5. No duplicate pipelines for the same bot (idempotency holds).

---

## Suggested R&D spikes (priority)

1. **Webhook reliability** — With only `webhook_url` on Create Bot, capture 10 test meetings: % delivered vs poll-only.  
2. **`recording_url` timing** — Histogram delay after `finished`.  
3. **Download auth** — cURL one `recording_url` without Skribby API key; note 401/403 behavior.  
4. **Plan limits** — Concurrency, storage retention, max recording length.
