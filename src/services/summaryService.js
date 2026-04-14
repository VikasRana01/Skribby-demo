// Meeting summary from transcript (your OpenAI / compatible API for chat — separate from transcription).
const OpenAI = require('openai');
const pool = require('../db');
const transcription = require('./transcriptionService');
require('dotenv').config();

function getSummaryOpenAI() {
  const apiKey =
    process.env.SUMMARY_OPENAI_API_KEY ||
    process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('Set SUMMARY_OPENAI_API_KEY or OPENAI_API_KEY for summaries');
  const baseURL =
    (process.env.SUMMARY_OPENAI_BASE_URL || process.env.OPENAI_API_BASE || '').trim() || undefined;
  return new OpenAI({ apiKey, baseURL });
}

function summaryMaxTranscriptChars() {
  const n = parseInt(process.env.SUMMARY_MAX_TRANSCRIPT_CHARS || '120000', 10);
  return Number.isFinite(n) && n > 8000 ? n : 120000;
}

function clipTranscriptForPrompt(transcript) {
  const t = String(transcript);
  const max = summaryMaxTranscriptChars();
  if (t.length <= max) return t;
  const head = Math.floor(max * 0.55);
  const tail = max - head - 100;
  return `${t.slice(0, head)}\n\n[… ${t.length - head - tail} characters omitted from middle …]\n\n${t.slice(-tail)}`;
}

function extractJsonObject(raw) {
  let t = String(raw || '').trim();
  const fence = /```(?:json)?\s*([\s\S]*?)```/im.exec(t);
  if (fence) t = fence[1].trim();
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start >= 0 && end > start) t = t.slice(start, end + 1);
  return t;
}

function normalizeSummaryPayload(obj) {
  if (!obj || typeof obj !== 'object') {
    return {
      headline: '',
      summary: 'Could not parse model output.',
      key_points: [],
      action_items: [],
      decisions: [],
      next_steps: '',
    };
  }
  const rawHead =
    (typeof obj.headline === 'string' && obj.headline.trim()) ||
    (typeof obj.title === 'string' && obj.title.trim()) ||
    '';
  const headline = rawHead.slice(0, 500);
  return {
    headline,
    summary: typeof obj.summary === 'string' ? obj.summary.trim() : '',
    key_points: Array.isArray(obj.key_points) ? obj.key_points.map(String).filter(Boolean) : [],
    action_items: Array.isArray(obj.action_items) ? obj.action_items.map(String).filter(Boolean) : [],
    decisions: Array.isArray(obj.decisions) ? obj.decisions.map(String).filter(Boolean) : [],
    next_steps: typeof obj.next_steps === 'string' ? obj.next_steps.trim() : '',
  };
}

function summaryJsonModeEnabled() {
  return !['false', '0', 'no'].includes(String(process.env.SUMMARY_JSON_MODE || 'true').toLowerCase());
}

async function generateSummary(transcript, meetingTitle = 'Meeting') {
  const openai = getSummaryOpenAI();
  const model = (process.env.SUMMARY_MODEL || 'gpt-4o-mini').trim();
  const clipped = clipTranscriptForPrompt(transcript);
  const useJsonFormat = summaryJsonModeEnabled();

  console.log(`🤖 Summary: model "${model}" for "${meetingTitle}" (${clipped.length} chars of transcript)`);

  const systemPrompt = `You are a meeting analyst. Output a single valid JSON object only — no markdown code fences, no text before or after the JSON.

Rules:
- If the transcript is repetitive, nonsensical, mostly silence hallucinations, too short, or not a real discussion: still return valid JSON. Put a brief honest explanation in "summary" (1–3 sentences). Use empty arrays for lists when nothing real exists.
- Never write long refusals or meta-commentary outside JSON. Never say "As an AI I cannot" in prose outside the JSON values.
- Prefer the same language as the transcript for "headline", "summary", "key_points", and "next_steps" when the transcript is clearly in one language.
- "headline": a short, specific card title for this meeting (about 4–12 words). Describe the main topic or outcome — not generic text like "Meeting" or "Weekly call". No trailing punctuation unless part of a name.
- "key_points", "action_items", and "decisions" must be JSON arrays of strings (use [] if none).`;

  const userPrompt = `Meeting title (hint): ${meetingTitle}

Transcript:
---
${clipped}
---

Return exactly one JSON object with these keys:
{"headline": string, "summary": string, "key_points": string[], "action_items": string[], "decisions": string[], "next_steps": string}`;

  const params = {
    model,
    temperature: 0.2,
    max_tokens: 2800,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
  };

  if (useJsonFormat) {
    params.response_format = { type: 'json_object' };
  }

  let raw = '';
  try {
    const { choices } = await openai.chat.completions.create(params);
    raw = (choices[0]?.message?.content || '').trim();
  } catch (err) {
    const msg = err.message || '';
    if (useJsonFormat && params.response_format && /response_format|json_object|not support/i.test(msg)) {
      delete params.response_format;
      const { choices } = await openai.chat.completions.create(params);
      raw = (choices[0]?.message?.content || '').trim();
    } else {
      throw err;
    }
  }

  let parsed;
  try {
    parsed = JSON.parse(extractJsonObject(raw));
  } catch {
    return normalizeSummaryPayload({
      headline: '',
      summary: raw.slice(0, 2000) || 'Model returned non-JSON output.',
      key_points: [],
      action_items: [],
      decisions: [],
      next_steps: '',
    });
  }

  return normalizeSummaryPayload(parsed);
}

async function processSummary({ userId, botSessionId, transcript, meetingTitle }) {
  const { rows } = await pool.query(
    `INSERT INTO summaries (user_id, bot_session_id, meeting_title, transcript, status)
     VALUES ($1,$2,$3,$4,'processing') RETURNING id`,
    [userId, botSessionId, meetingTitle, transcript]
  );
  const summaryId = rows[0].id;

  try {
    const data = await generateSummary(transcript, meetingTitle);

    await pool.query(
      `UPDATE summaries SET
         headline=$1, summary=$2, key_points=$3, action_items=$4, decisions=$5,
         next_steps=$6, status='completed', updated_at=NOW()
       WHERE id=$7`,
      [
        data.headline || null,
        data.summary,
        JSON.stringify(data.key_points || []),
        JSON.stringify(data.action_items || []),
        JSON.stringify(data.decisions || []),
        data.next_steps || '',
        summaryId,
      ]
    );

    console.log(`✅ Summary saved: ID ${summaryId}`);
    return { summaryId, ...data };
  } catch (err) {
    await pool.query(
      `UPDATE summaries SET status='failed', error_message=$1, updated_at=NOW() WHERE id=$2`,
      [err.message, summaryId]
    );
    throw err;
  }
}

/**
 * One row per bot session: latest summary if any, else transcript-only rows from bot_sessions still appear.
 */
async function getUserSummaries(userId, limit = 20, offset = 0) {
  const { rows } = await pool.query(
    `SELECT * FROM (
       SELECT DISTINCT ON (bs.id)
         s.id,
         bs.id AS bot_session_id,
         COALESCE(s.user_id, bs.user_id) AS user_id,
         COALESCE(s.meeting_title, bs.meeting_title) AS meeting_title,
         COALESCE(s.transcript, bs.transcript) AS transcript,
         s.summary,
         s.key_points,
         s.action_items,
         s.decisions,
         s.next_steps,
         s.status,
         s.error_message,
         COALESCE(s.created_at, bs.updated_at) AS created_at,
         s.updated_at,
         bs.meeting_url,
         bs.bot_name,
         bs.bot_id,
         bs.media_archive_filename,
         bs.joined_at,
         bs.left_at,
         bs.updated_at AS bot_session_updated_at,
         bs.created_at AS bot_session_created_at
       FROM bot_sessions bs
       LEFT JOIN summaries s ON s.bot_session_id = bs.id
       WHERE bs.user_id = $1
         AND (
           s.id IS NOT NULL
           OR (bs.transcript IS NOT NULL AND length(trim(bs.transcript)) > 0)
         )
       ORDER BY bs.id, s.created_at DESC NULLS LAST
     ) sub
     ORDER BY sub.created_at DESC
     LIMIT $2 OFFSET $3`,
    [userId, limit, offset]
  );
  for (const row of rows) {
    const ref =
      row.left_at ||
      row.bot_session_updated_at ||
      row.bot_session_created_at ||
      row.created_at;
    const p = await transcription.resolveArchivedRecordingPath(
      row.bot_id,
      row.media_archive_filename,
      { referenceTime: ref }
    );
    row.recording_available = Boolean(p);
    row.display_title = displayTitleForSummaryRow(row);
  }
  return rows;
}

async function getSummaryById(id, userId) {
  const { rows } = await pool.query(
    `SELECT s.*, bs.meeting_url, bs.bot_name, bs.joined_at, bs.left_at
     FROM summaries s
     JOIN bot_sessions bs ON s.bot_session_id = bs.id
     WHERE s.id=$1 AND s.user_id=$2`,
    [id, userId]
  );
  const row = rows[0] || null;
  if (row) row.display_title = displayTitleForSummaryRow(row);
  return row;
}

/** Short title from summary body when DB headline is missing (older rows). */
function deriveTitleFromSummaryText(text) {
  const t = String(text || '').trim().replace(/\s+/g, ' ');
  if (t.length < 12) return null;
  const cut = t.match(/^.{12,140}?[.!?](?=\s|$)/);
  if (cut) return cut[0].trim().slice(0, 160);
  return (t.length <= 100 ? t : `${t.slice(0, 97).trim()}…`).slice(0, 160);
}

function displayTitleForSummaryRow(row) {
  if (row.headline && String(row.headline).trim()) return String(row.headline).trim().slice(0, 200);
  if (row.status === 'completed' && row.summary) {
    const d = deriveTitleFromSummaryText(row.summary);
    if (d) return d;
  }
  if (row.meeting_title && String(row.meeting_title).trim()) return String(row.meeting_title).trim().slice(0, 200);
  return 'Meeting';
}

async function hasInProgressOrCompletedSummary(botSessionId) {
  const { rows } = await pool.query(
    `SELECT 1 FROM summaries
     WHERE bot_session_id = $1 AND status IN ('processing', 'completed')
     LIMIT 1`,
    [botSessionId]
  );
  return rows.length > 0;
}

module.exports = {
  generateSummary,
  processSummary,
  getUserSummaries,
  getSummaryById,
  hasInProgressOrCompletedSummary,
};
