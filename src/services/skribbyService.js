// src/services/skribbyService.js  —  Skribby platform API
const axios = require('axios');
const pool  = require('../db');
const { detectSkribbyService } = require('./meetingPlatforms');
require('dotenv').config();

const BASE = (process.env.SKRIBBY_API_BASE || 'https://platform.skribby.io/api/v1').replace(/\/$/, '');
const KEY  = process.env.SKRIBBY_API_KEY;

const api = axios.create({
  baseURL: BASE,
  headers: {
    Authorization: `Bearer ${KEY}`,
    'Content-Type': 'application/json',
  },
});

/** Per-bot URL on Create Bot — Skribby POSTs here (no dashboard "add endpoint" on many plans). */
function webhookUrl() {
  const base = (process.env.SKRIBBY_WEBHOOK_BASE || '').replace(/\/$/, '');
  if (!base) return null;
  return `${base}/api/webhook/skribby`;
}

async function createBot({ meetingUrl, meetingTitle, userId, botName, scheduledStartTime } = {}) {
  const name = botName || process.env.BOT_NAME || 'AI Notetaker';
  const wh = webhookUrl();
  const service = detectSkribbyService(meetingUrl);
  if (!service) throw new Error('Unsupported meeting_url for Skribby (need Zoom, Google Meet, or Teams link)');

  const nowSec = Math.floor(Date.now() / 1000);
  let schedSec = null;
  if (scheduledStartTime != null && scheduledStartTime !== '') {
    const n = Number(scheduledStartTime);
    if (Number.isFinite(n) && n > nowSec) schedSec = Math.floor(n);
  }

  const payload = {
    // Skribby catalog model id only — your OPENAI_API_KEY / TRANSCRIPTION_* keys are never sent to Skribby (local STT after recording_url).
    transcription_model: process.env.SKRIBBY_TRANSCRIPTION_MODEL || 'openai/whisper-large-v3',
    service,
    meeting_url:         meetingUrl,
    bot_name:            name,
    lang:                process.env.SKRIBBY_LANG || 'en',
    custom_metadata:     { app_user_id: String(userId) },
  };
  if (wh) payload.webhook_url = wh;
  if (process.env.SKRIBBY_RECORD_VIDEO === 'true') payload.video = true;
  if (schedSec != null) payload.scheduled_start_time = schedSec;

  const modeLabel = schedSec != null ? `scheduled @ ${schedSec}` : 'immediate';
  console.log(`🤖 Skribby: creating bot (${modeLabel}) for ${meetingUrl}${wh ? ` (webhook: ${wh})` : ' (no webhook — set SKRIBBY_WEBHOOK_BASE)'}`);

  const { data } = await api.post('/bot', payload);

  const initialStatus = schedSec != null ? 'scheduled' : 'created';
  const scheduledJoinAt = schedSec != null ? new Date(schedSec * 1000) : null;

  const { rows } = await pool.query(
    `INSERT INTO bot_sessions (user_id, bot_id, meeting_url, meeting_title, bot_name, status, scheduled_join_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [userId, data.id, meetingUrl, meetingTitle || 'Meeting', name, initialStatus, scheduledJoinAt]
  );

  console.log(`✅ Skribby bot created: ${data.id}`);
  return { bot: data, session: rows[0], scheduled_start_time: schedSec };
}

async function getBot(botId) {
  const id = encodeURIComponent(String(botId).trim());
  const { data } = await api.get(`/bot/${id}`);
  return data;
}

function formatTranscript(transcriptData) {
  if (!transcriptData || !Array.isArray(transcriptData)) return '';
  return transcriptData
    .map((seg) => {
      const speaker =
        seg.speaker_name ??
        (seg.speaker != null ? `Speaker ${seg.speaker}` : 'Speaker');
      let text = (seg.transcript || '').trim();
      if (!text && Array.isArray(seg.words)) {
        text = seg.words.map((w) => w.text || w.word || '').join(' ').trim();
      }
      if (!text && Array.isArray(seg.utterances) && seg.utterances.length) {
        text = seg.utterances.map((u) => u.text || '').join(' ').trim();
      }
      return text ? `${speaker}: ${text}` : null;
    })
    .filter(Boolean)
    .join('\n');
}

async function stopBot(botId) {
  const id = encodeURIComponent(String(botId).trim());
  const { data } = await api.post(`/bot/${id}/stop`, {});
  return data;
}

async function getSessionByBotId(botId) {
  const { rows } = await pool.query(
    'SELECT * FROM bot_sessions WHERE bot_id=$1', [botId]
  );
  return rows[0] || null;
}

async function getUserSessions(userId) {
  const { rows } = await pool.query(
    `SELECT bs.*, s.id as summary_id, s.status as summary_status, s.summary, s.key_points, s.action_items
     FROM bot_sessions bs
     LEFT JOIN summaries s ON bs.id = s.bot_session_id
     WHERE bs.user_id = $1
     ORDER BY bs.created_at DESC`,
    [userId]
  );
  return rows;
}

async function updateSessionStatus(botId, status, extra = {}) {
  const sets  = ['status=$2', 'updated_at=NOW()'];
  const vals  = [botId, status];
  let   idx   = 3;

  if (extra.provider_status) { sets.push(`provider_status=$${idx++}`); vals.push(extra.provider_status); }
  if (extra.transcript)      { sets.push(`transcript=$${idx++}`);       vals.push(extra.transcript); }
  if (extra.joined_at)       { sets.push(`joined_at=$${idx++}`);        vals.push(extra.joined_at); }
  if (extra.left_at)         { sets.push(`left_at=$${idx++}`);          vals.push(extra.left_at); }

  await pool.query(
    `UPDATE bot_sessions SET ${sets.join(',')} WHERE bot_id=$1`,
    vals
  );
}

module.exports = {
  createBot,
  getBot,
  formatTranscript,
  stopBot,
  getSessionByBotId,
  getUserSessions,
  updateSessionStatus,
  webhookUrl,
};
