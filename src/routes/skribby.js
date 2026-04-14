// src/routes/skribby.js  —  Skribby bot management
const fs    = require('fs');
const path  = require('path');
const router  = require('express').Router();
const auth    = require('../middleware/auth');
const pool    = require('../db');
const skribby        = require('../services/skribbyService');
const summary        = require('../services/summaryService');
const transcription  = require('../services/transcriptionService');
const { isSupportedMeetingUrl } = require('../services/meetingPlatforms');

const RECORDING_SERVE_MIME = {
  mp3:  'audio/mpeg',
  wav:  'audio/wav',
  m4a:  'audio/mp4',
  ogg:  'audio/ogg',
  webm: 'video/webm',
  mp4:  'video/mp4',
  mpeg: 'video/mpeg',
  mpga: 'audio/mpeg',
  flac: 'audio/flac',
};

function ownsSession(session, user) {
  return session && Number(session.user_id) === Number(user.id);
}

function formatAxiosErrData(d) {
  if (d == null) return null;
  if (typeof d === 'string') return d;
  if (d.message) return typeof d.message === 'string' ? d.message : JSON.stringify(d.message);
  if (d.detail) return typeof d.detail === 'string' ? d.detail : JSON.stringify(d.detail);
  if (d.error) return typeof d.error === 'string' ? d.error : JSON.stringify(d.error);
  try {
    return JSON.stringify(d);
  } catch {
    return 'Request failed';
  }
}

router.post('/bot', auth, async (req, res) => {
  const { meeting_url, meeting_title, scheduled_start_time } = req.body;

  if (!meeting_url)
    return res.status(400).json({ error: 'meeting_url is required' });

  if (!isSupportedMeetingUrl(meeting_url))
    return res.status(400).json({
      error: 'Unsupported meeting URL. Use a Zoom (zoom.us/j/...), Google Meet (meet.google.com/...), or Microsoft Teams join link.',
    });

  try {
    const result = await skribby.createBot({
      meetingUrl:          meeting_url,
      meetingTitle:        meeting_title || 'Meeting',
      userId:              req.user.id,
      botName:             process.env.BOT_NAME || 'AI Notetaker',
      scheduledStartTime:  scheduled_start_time,
    });

    const name = result.bot.bot_name || process.env.BOT_NAME || 'AI Notetaker';
    const whenIso =
      result.scheduled_start_time != null
        ? new Date(result.scheduled_start_time * 1000).toISOString()
        : null;
    const message =
      result.scheduled_start_time != null
        ? `Bot "${name}" is scheduled; Skribby will auto-join at ${whenIso} (status: scheduled until then).`
        : `Bot "${name}" is joining the meeting`;

    res.status(201).json({
      success: true,
      message,
      bot_id:  result.bot.id,
      session: result.session,
      scheduled_start_time: result.scheduled_start_time ?? undefined,
    });
  } catch (err) {
    console.error('Skribby create bot error:', err.response?.data || err.message);
    const msg = err.response?.data?.message || err.response?.data?.detail || err.message;
    res.status(err.response?.status || 500).json({ error: typeof msg === 'string' ? msg : JSON.stringify(msg) });
  }
});

router.get('/bot/:botId', auth, async (req, res) => {
  try {
    const session = await skribby.getSessionByBotId(req.params.botId);
    if (!ownsSession(session, req.user))
      return res.status(404).json({ error: 'Bot not found' });

    const botData = await skribby.getBot(req.params.botId);
    const skStatus = botData.status || '';
    await skribby.updateSessionStatus(req.params.botId, mapSkribbyStatus(skStatus), {
      provider_status: skStatus,
    });

    res.json({ success: true, bot: botData, session });
  } catch (err) {
    res.status(500).json({ error: err.response?.data?.message || err.message });
  }
});

router.post('/bot/:botId/stop', auth, async (req, res) => {
  const botId = String(req.params.botId || '').trim();
  try {
    const session = await skribby.getSessionByBotId(botId);
    if (!ownsSession(session, req.user))
      return res.status(404).json({ error: 'Bot not found' });

    let live = null;
    try {
      live = await skribby.getBot(botId);
    } catch (e) {
      console.warn(`Skribby getBot before stop (${botId}):`, e.response?.data || e.message);
    }

    const terminal = new Set(['finished', 'failed', 'not_admitted']);
    if (live?.status && terminal.has(live.status)) {
      await skribby.updateSessionStatus(botId, live.status === 'finished' ? 'call_ended' : 'failed', {
        provider_status: live.status,
        left_at:         new Date(),
      });
      return res.json({
        success: true,
        message: live.status === 'finished'
          ? 'Bot already finished; session updated.'
          : 'Bot already ended; session updated.',
      });
    }

    await skribby.stopBot(botId);
    await skribby.updateSessionStatus(botId, 'call_ended', {
      left_at:           new Date(),
      provider_status: 'manually_stopped',
    });

    res.json({ success: true, message: 'Bot is leaving the meeting' });
  } catch (err) {
    const status = err.response?.status || 500;
    const msg =
      formatAxiosErrData(err.response?.data) || err.message || 'Stop bot failed';
    console.error('Skribby stop bot error:', err.response?.data || err.message);
    res.status(status >= 400 && status < 600 ? status : 500).json({ error: msg });
  }
});

router.get('/sessions', auth, async (req, res) => {
  try {
    const sessions = await skribby.getUserSessions(req.user.id);
    res.json({ success: true, sessions });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/bot/:botId/summarize', auth, async (req, res) => {
  try {
    const session = await skribby.getSessionByBotId(req.params.botId);
    if (!ownsSession(session, req.user))
      return res.status(404).json({ error: 'Bot not found' });

    res.json({ success: true, message: 'Summary generation started' });

    processTranscriptAndSummarize(session).catch((e) =>
      console.error('Manual summarize error:', e.message)
    );
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/summaries', auth, async (req, res) => {
  try {
    const summaries = await summary.getUserSummaries(
      req.user.id,
      parseInt(req.query.limit)  || 20,
      parseInt(req.query.offset) || 0
    );
    res.json({ success: true, summaries });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/summaries/:id', auth, async (req, res) => {
  try {
    const s = await summary.getSummaryById(req.params.id, req.user.id);
    if (!s) return res.status(404).json({ error: 'Summary not found' });
    res.json({ success: true, summary: s });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** Stream archived meeting audio/video (Bearer auth; file lives under downloads/skribby-audio). */
router.get('/bot-session/:sessionId/recording', auth, async (req, res) => {
  try {
    const sessionId = parseInt(req.params.sessionId, 10);
    if (!sessionId || Number.isNaN(sessionId)) {
      return res.status(400).json({ error: 'Invalid session id' });
    }
    const { rows } = await pool.query(
      `SELECT bot_id, media_archive_filename, left_at, updated_at AS session_updated_at, created_at AS session_created_at
       FROM bot_sessions WHERE id = $1 AND user_id = $2`,
      [sessionId, req.user.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Session not found' });

    const r0 = rows[0];
    const filePath = await transcription.resolveArchivedRecordingPath(
      r0.bot_id,
      r0.media_archive_filename,
      {
        referenceTime: r0.left_at || r0.session_updated_at || r0.session_created_at,
      }
    );
    if (!filePath) return res.status(404).json({ error: 'No archived recording for this session' });

    const ext = path.extname(filePath).replace(/^\./, '').toLowerCase();
    const mime = RECORDING_SERVE_MIME[ext] || 'application/octet-stream';
    const base = path.basename(filePath);
    res.setHeader('Content-Type', mime);
    res.setHeader('Content-Disposition', `inline; filename="${base}"`);
    fs.createReadStream(filePath).pipe(res);
  } catch (err) {
    console.error('Recording stream error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/** Default: record via Skribby, then download audio and transcribe with YOUR API (not Skribby’s transcript). */
function postMeetingTranscriptSource() {
  const v = (process.env.POST_MEETING_TRANSCRIPT_SOURCE || 'recording_openai_whisper').toLowerCase().trim();
  if (v === 'skribby_native_then_whisper') return 'skribby_native_then_whisper';
  if (v === 'recording_custom_http') return 'recording_custom_http';
  return 'recording_openai_whisper';
}

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Skribby may expose recording_url only after processing; poll GET /bot briefly.
 */
async function resolveRecordingUrl(botId, initialUrl) {
  let url = initialUrl || null;
  const attempts = Math.max(1, parseInt(process.env.RECORDING_URL_MAX_ATTEMPTS || '12', 10) || 12);
  const delayMs = Math.max(2000, parseInt(process.env.RECORDING_URL_RETRY_MS || '5000', 10) || 5000);

  for (let i = 0; i < attempts; i++) {
    if (i > 0) {
      console.log(`   Waiting for recording_url (attempt ${i + 1}/${attempts})...`);
      await sleep(delayMs);
    }
    try {
      const bot = await skribby.getBot(botId);
      if (bot.recording_url) url = bot.recording_url;
    } catch (e) {
      console.warn(`   getBot while waiting for recording: ${e.message}`);
    }
    if (url) return url;
  }
  return url;
}

async function processTranscriptAndSummarize(session, recordingUrl = null) {
  const mode = postMeetingTranscriptSource();
  console.log(`📝 Post-meeting pipeline for bot ${session.bot_id} (transcript mode: ${mode})`);
  let transcript = '';

  try {
    const botData = await skribby.getBot(session.bot_id);

    if (mode === 'skribby_native_then_whisper') {
      transcript = skribby.formatTranscript(botData.transcript);
      console.log(`   Skribby native transcript: ${transcript.length} chars`);
      if (!transcript || transcript.trim().length < 50) {
        recordingUrl = recordingUrl || botData.recording_url || null;
        if (recordingUrl) {
          console.log(`   Falling back to audio download + your transcription API...`);
          const fb = (process.env.POST_MEETING_FALLBACK_TRANSCRIPTION || 'recording_openai_whisper')
            .toLowerCase()
            .trim();
          const fbMode = fb === 'recording_custom_http' ? 'recording_custom_http' : 'recording_openai_whisper';
          const tr = await transcription.transcribeFromRecordingUrl(recordingUrl, fbMode, {
            botId: session.bot_id,
          });
          transcript = tr.text;
          if (tr.mediaFilename) {
            await pool.query(
              'UPDATE bot_sessions SET media_archive_filename = $1 WHERE bot_id = $2',
              [tr.mediaFilename, session.bot_id]
            );
          }
        }
      }
    } else {
      recordingUrl = await resolveRecordingUrl(session.bot_id, recordingUrl || botData.recording_url);
      if (!recordingUrl) {
        console.warn(`⚠️ No recording_url for bot ${session.bot_id} — cannot transcribe from audio`);
        await skribby.updateSessionStatus(session.bot_id, 'done', { transcript: '' });
        return;
      }
      console.log(`   Downloading meeting audio, then transcribing with your configured STT...`);
      const tr = await transcription.transcribeFromRecordingUrl(recordingUrl, mode, {
        botId: session.bot_id,
      });
      transcript = tr.text;
      if (tr.mediaFilename) {
        await pool.query(
          'UPDATE bot_sessions SET media_archive_filename = $1 WHERE bot_id = $2',
          [tr.mediaFilename, session.bot_id]
        );
      }
    }

    if (!transcript || transcript.trim().length < 50) {
      console.warn(`⚠️ No usable transcript for bot ${session.bot_id} — skipping summary`);
      await skribby.updateSessionStatus(session.bot_id, 'done', { transcript: transcript || '' });
      return;
    }

    await skribby.updateSessionStatus(session.bot_id, 'done', { transcript });
    console.log(`   Transcript saved (${transcript.length} chars)`);

    const doSummary = !['false', '0', 'no'].includes(
      String(process.env.SUMMARY_AFTER_TRANSCRIPTION || 'true').toLowerCase()
    );
    if (doSummary) {
      console.log(`   Generating summary (${process.env.SUMMARY_MODEL || 'gpt-4'})...`);
      await summary.processSummary({
        userId:       session.user_id,
        botSessionId: session.id,
        transcript,
        meetingTitle: session.meeting_title,
      });
      console.log(`✅ Summary complete for bot ${session.bot_id}`);
    } else {
      console.log(`✅ Post-meeting done (SUMMARY_AFTER_TRANSCRIPTION disabled) for bot ${session.bot_id}`);
    }
  } catch (err) {
    console.error(`❌ processTranscriptAndSummarize failed:`, err.message);
    await skribby.updateSessionStatus(session.bot_id, 'failed');
  }
}

function mapSkribbyStatus(status) {
  const map = {
    scheduled:    'scheduled',
    booting:      'joining',
    joining:      'joining',
    recording:    'in_call',
    processing:   'in_call',
    transcribing: 'in_call',
    leaving:      'call_ended',
    finished:     'call_ended',
    not_admitted: 'failed',
    bot_detected: 'joining',
    auth_required:'joining',
    invalid_credentials: 'failed',
    failed:       'failed',
  };
  return map[status] || 'created';
}

module.exports = router;
module.exports.processTranscriptAndSummarize = processTranscriptAndSummarize;
