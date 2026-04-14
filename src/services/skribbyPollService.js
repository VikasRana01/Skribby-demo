// Poll GET /bot/{id} for sessions that are not terminal locally — works when no per-bot webhook URL or deliveries fail.
require('dotenv').config();
const pool    = require('../db');
const skribby = require('./skribbyService');
const { applySkribbyStatusUpdate } = require('./skribbyLifecycle');

const DEFAULT_MS = 60_000;

function pollEnabled() {
  const v = (process.env.SKRIBBY_POLL_ENABLED || 'true').toLowerCase();
  return v !== 'false' && v !== '0';
}

function intervalMs() {
  const n = parseInt(process.env.SKRIBBY_POLL_INTERVAL_MS || String(DEFAULT_MS), 10);
  return Number.isFinite(n) && n >= 15_000 ? n : DEFAULT_MS;
}

async function tick() {
  if (!process.env.SKRIBBY_API_KEY) return;

  const { rows } = await pool.query(
    `SELECT bot_id FROM bot_sessions
     WHERE created_at > NOW() - INTERVAL '72 hours'
       AND status NOT IN ('done', 'failed')
     ORDER BY updated_at DESC
     LIMIT 25`
  );

  for (const row of rows) {
    const botId = row.bot_id;
    try {
      const bot = await skribby.getBot(botId);
      if (!bot?.status) continue;
      await applySkribbyStatusUpdate(botId, bot.status, bot.stop_reason);
    } catch (e) {
      console.warn(`Skribby poll GET /bot/${botId}:`, e.response?.data || e.message);
    }
  }
}

let timer = null;

function start() {
  if (!pollEnabled()) {
    console.log('Skribby status polling disabled (SKRIBBY_POLL_ENABLED=false)');
    return;
  }
  const ms = intervalMs();
  console.log(`Skribby status polling every ${ms / 1000}s (webhook optional)`);
  timer = setInterval(() => {
    tick().catch((e) => console.error('Skribby poll tick error:', e.message));
  }, ms);
  if (typeof timer.unref === 'function') timer.unref();
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
}

module.exports = { start, stop, tick };
