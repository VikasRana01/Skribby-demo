/**
 * Pulls upcoming meetings from Zoom + Google + Microsoft (native APIs only),
 * persists them in synced_calendar_meetings, and registers Skribby bots with
 * scheduled_start_time when the meeting is far enough ahead — otherwise joins
 * immediately. Skribby’s platform performs the timed join (no cron on this app).
 */
const pool = require('../db');
const zoom = require('./zoomService');
const google = require('./googleCalendarService');
const ms = require('./microsoftGraphService');
const skribby = require('./skribbyService');
const { isSupportedMeetingUrl } = require('./meetingPlatforms');
require('dotenv').config();

function normalizeZoomMeeting(m) {
  return {
    source:      'zoom',
    external_id: String(m.id),
    title:       m.topic || 'Zoom meeting',
    start:       m.start_time,
    end:         null,
    join_url:    m.join_url || null,
    platform:    'zoom',
    raw_source:  'zoom_api',
  };
}

/**
 * @returns {{ by: object, merged: object[], errors: {source, message}[] }}
 */
async function fetchProviderMeetings(userId, days, sources) {
  const by = { zoom: [], google: [], microsoft: [] };
  const errors = [];

  if (sources.includes('zoom')) {
    try {
      if (await zoom.isConnected(userId)) {
        const list = await zoom.getMeetings(userId, 'upcoming');
        by.zoom = list.map(normalizeZoomMeeting);
      }
    } catch (e) {
      errors.push({ source: 'zoom', message: e.message });
    }
  }

  if (sources.includes('google')) {
    try {
      if (await google.isConnected(userId)) {
        const list = await google.listUpcomingEvents(userId, { days, meetOnly: true });
        by.google = list.map((e) => ({
          ...e,
          source:      'google',
          external_id: String(e.id),
        }));
      }
    } catch (e) {
      errors.push({ source: 'google', message: e.message });
    }
  }

  if (sources.includes('microsoft')) {
    try {
      if (await ms.isConnected(userId)) {
        const list = await ms.listUpcomingEvents(userId, { days, teamsOnly: true });
        by.microsoft = list.map((e) => ({
          ...e,
          source:      'microsoft',
          external_id: String(e.id),
        }));
      }
    } catch (e) {
      errors.push({ source: 'microsoft', message: e.message });
    }
  }

  const merged = [...by.zoom, ...by.google, ...by.microsoft].sort((a, b) => {
    const ta = a.start ? new Date(a.start).getTime() : 0;
    const tb = b.start ? new Date(b.start).getTime() : 0;
    return ta - tb;
  });

  return { by, merged, errors };
}

function parseStart(m) {
  const s = m.start || m.start_time;
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

function autoScheduleBotsEnabled() {
  return !['false', '0', 'no'].includes(String(process.env.AUTO_SCHEDULE_BOTS || 'true').toLowerCase());
}

function imminentMs() {
  const n = parseInt(process.env.AUTO_SCHEDULE_IMMINENT_SEC || '180', 10);
  return Number.isFinite(n) && n >= 0 ? n * 1000 : 180000;
}

function gracePastMs() {
  const n = parseInt(process.env.AUTO_SCHEDULE_GRACE_PAST_MIN || '10', 10);
  return Number.isFinite(n) && n >= 0 ? n * 60 * 1000 : 600000;
}

/**
 * Upsert meetings with a supported join URL; delete rows not seen this sync.
 */
async function persistSyncedMeetings(userId, merged) {
  const syncMark = new Date();
  const toSave = merged.filter((m) => {
    const ju = m.join_url;
    return ju && isSupportedMeetingUrl(ju) && parseStart(m);
  });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const m of toSave) {
      const startAt = parseStart(m);
      const endRaw = m.end;
      let endAt = null;
      if (endRaw) {
        const e = new Date(endRaw);
        if (!Number.isNaN(e.getTime())) endAt = e;
      }
      await client.query(
        `INSERT INTO synced_calendar_meetings (
           user_id, source, external_id, title, start_at, end_at, join_url, platform, last_synced_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (user_id, source, external_id) DO UPDATE SET
           title = EXCLUDED.title,
           start_at = EXCLUDED.start_at,
           end_at = EXCLUDED.end_at,
           join_url = EXCLUDED.join_url,
           platform = EXCLUDED.platform,
           last_synced_at = EXCLUDED.last_synced_at,
           schedule_error = CASE
             WHEN synced_calendar_meetings.start_at IS DISTINCT FROM EXCLUDED.start_at
               OR synced_calendar_meetings.join_url IS DISTINCT FROM EXCLUDED.join_url
             THEN NULL
             ELSE synced_calendar_meetings.schedule_error
           END`,
        [
          userId,
          m.source,
          String(m.external_id),
          (m.title || 'Meeting').slice(0, 500),
          startAt,
          endAt,
          m.join_url,
          m.platform || null,
          syncMark,
        ]
      );
    }
    const del = await client.query(
      `DELETE FROM synced_calendar_meetings
       WHERE user_id = $1 AND last_synced_at < $2`,
      [userId, syncMark]
    );
    await client.query('COMMIT');
    return { saved: toSave.length, removed: del.rowCount || 0 };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

async function schedulePendingBots(userId) {
  if (!process.env.SKRIBBY_API_KEY) {
    return { created: 0, details: [], skipped: 'SKRIBBY_API_KEY missing' };
  }
  if (!autoScheduleBotsEnabled()) {
    return { created: 0, details: [], skipped: 'AUTO_SCHEDULE_BOTS disabled' };
  }

  const { rows } = await pool.query(
    `SELECT * FROM synced_calendar_meetings
     WHERE user_id = $1
       AND skribby_bot_id IS NULL
       AND join_url IS NOT NULL`,
    [userId]
  );

  const now = Date.now();
  const imminent = imminentMs();
  const gracePast = gracePastMs();
  const details = [];
  let created = 0;

  for (const row of rows) {
    const t0 = new Date(row.start_at).getTime();
    if (Number.isNaN(t0)) continue;
    if (t0 < now - gracePast) continue;
    if (!isSupportedMeetingUrl(row.join_url)) continue;

    const useSkribbySchedule = t0 > now + imminent;
    const schedOpt = useSkribbySchedule ? Math.floor(t0 / 1000) : undefined;

    try {
      const result = await skribby.createBot({
        meetingUrl:         row.join_url,
        meetingTitle:       row.title || 'Meeting',
        userId,
        botName:            process.env.BOT_NAME || 'AI Notetaker',
        scheduledStartTime: schedOpt,
      });
      await pool.query(
        `UPDATE synced_calendar_meetings
         SET skribby_bot_id = $1, schedule_error = NULL, updated_at = NOW()
         WHERE id = $2`,
        [result.bot.id, row.id]
      );
      created += 1;
      details.push({
        source: row.source,
        external_id: row.external_id,
        bot_id: result.bot.id,
        mode: useSkribbySchedule ? 'scheduled' : 'immediate',
      });
    } catch (err) {
      const msg =
        err.response?.data?.message ||
        err.response?.data?.detail ||
        err.message ||
        'createBot failed';
      const short = typeof msg === 'string' ? msg.slice(0, 500) : JSON.stringify(msg).slice(0, 500);
      await pool.query(
        `UPDATE synced_calendar_meetings SET schedule_error = $1, updated_at = NOW() WHERE id = $2`,
        [short, row.id]
      );
      details.push({
        source: row.source,
        external_id: row.external_id,
        error: short,
      });
    }
  }

  return { created, details };
}

async function enrichMergedWithSyncState(userId, merged) {
  if (!merged.length) return merged;
  const { rows } = await pool.query(
    `SELECT source, external_id, skribby_bot_id, schedule_error
     FROM synced_calendar_meetings WHERE user_id = $1`,
    [userId]
  );
  const map = new Map(rows.map((r) => [`${r.source}\0${r.external_id}`, r]));
  return merged.map((m) => {
    if (!m.source || m.external_id == null) return m;
    const key = `${m.source}\0${String(m.external_id)}`;
    const s = map.get(key);
    if (!s) return m;
    return {
      ...m,
      auto_bot_id: s.skribby_bot_id,
      auto_schedule_error: s.schedule_error,
    };
  });
}

/**
 * Full pipeline: fetch → persist → Skribby register → enrich list for UI.
 */
async function syncAndScheduleMeetings(userId, days, sources) {
  const { by, merged, errors } = await fetchProviderMeetings(userId, days, sources);
  const persist = await persistSyncedMeetings(userId, merged);
  const schedule = await schedulePendingBots(userId);
  const mergedOut = await enrichMergedWithSyncState(userId, merged);
  return {
    by,
    merged: mergedOut,
    errors,
    sync_meta: {
      persisted_rows: persist.saved,
      removed_stale:  persist.removed,
      bots_registered: schedule.created,
      schedule_attempts: schedule.details,
      schedule_skipped: schedule.skipped,
    },
  };
}

module.exports = {
  fetchProviderMeetings,
  persistSyncedMeetings,
  schedulePendingBots,
  enrichMergedWithSyncState,
  syncAndScheduleMeetings,
};
