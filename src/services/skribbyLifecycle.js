// Shared Skribby bot lifecycle: webhook + polling both use this (no dashboard "Add webhook" required).
const skribby = require('./skribbyService');

/** One post-meeting run per bot at a time (webhook + poll can both see `finished` in the same tick). */
const postMeetingPipelineQueued = new Set();

function mapSkribbyToInternal(status) {
  const m = {
    bot_detected:    'joining',
    auth_required:   'joining',
  };
  return m[status];
}

function summaryAfterTranscriptionEnabled() {
  return !['false', '0', 'no'].includes(
    String(process.env.SUMMARY_AFTER_TRANSCRIPTION || 'true').toLowerCase()
  );
}

async function hasPostMeetingWorkPending(botId) {
  const session = await skribby.getSessionByBotId(botId);
  if (!session) return false;
  const summarySvc = require('./summaryService');
  if (await summarySvc.hasInProgressOrCompletedSummary(session.id)) return false;

  if (
    !summaryAfterTranscriptionEnabled() &&
    session.status === 'done' &&
    session.transcript &&
    session.transcript.trim().length >= 50
  ) {
    return false;
  }

  return true;
}

function expectedProviderStatus(newStatus, stopReason) {
  const withReason =
    newStatus === 'finished' ||
    newStatus === 'not_admitted' ||
    newStatus === 'failed' ||
    newStatus === 'invalid_credentials';
  if (withReason) return `${newStatus}${stopReason ? `:${stopReason}` : ''}`;
  return newStatus;
}

/**
 * Apply a Skribby status (from webhook or from GET /bot polling).
 * When status is `finished`, schedules transcript + summary if not already started.
 */
async function applySkribbyStatusUpdate(botId, newStatus, stopReason) {
  if (!newStatus) return;

  const session = await skribby.getSessionByBotId(botId);
  if (!session) return;

  const nextProv = expectedProviderStatus(newStatus, stopReason);
  if (session.provider_status === nextProv) {
    // Already applied this Skribby status — do not re-queue pipeline (poll would fire every interval).
    return;
  }

  const internal = mapSkribbyToInternal(newStatus);

  switch (newStatus) {
    case 'scheduled':
      await skribby.updateSessionStatus(botId, 'scheduled', { provider_status: 'scheduled' });
      console.log(`📅 Bot scheduled (Skribby): ${botId}`);
      break;

    case 'joining':
    case 'booting':
      await skribby.updateSessionStatus(botId, 'joining', {
        provider_status: newStatus,
        joined_at:       new Date(),
      });
      console.log(`▶️  Bot joining: ${botId}`);
      break;

    case 'recording':
      await skribby.updateSessionStatus(botId, 'in_call', { provider_status: newStatus });
      console.log(`🔴 Bot recording: ${botId}`);
      break;

    case 'processing':
    case 'transcribing':
      await skribby.updateSessionStatus(botId, 'in_call', { provider_status: newStatus });
      console.log(`⏳ Bot ${newStatus}: ${botId}`);
      break;

    case 'leaving':
      await skribby.updateSessionStatus(botId, 'call_ended', {
        provider_status: newStatus,
        left_at:         new Date(),
      });
      console.log(`🚪 Bot leaving: ${botId}`);
      break;

    case 'finished':
      await skribby.updateSessionStatus(botId, 'call_ended', {
        provider_status: `${newStatus}${stopReason ? `:${stopReason}` : ''}`,
        left_at:         new Date(),
      });
      console.log(`✅ Bot finished: ${botId} — transcript + summary pipeline...`);
      if (await hasPostMeetingWorkPending(botId)) {
        schedulePostMeetingPipeline(botId);
      }
      break;

    case 'not_admitted':
    case 'failed':
    case 'invalid_credentials':
      await skribby.updateSessionStatus(botId, 'failed', {
        provider_status: `${newStatus}${stopReason ? `:${stopReason}` : ''}`,
      });
      console.error(`💀 Bot ended (${newStatus}): ${botId} — ${stopReason || ''}`);
      break;

    default:
      if (internal && newStatus) {
        await skribby.updateSessionStatus(botId, internal, { provider_status: newStatus });
      }
      console.log(`ℹ️  Skribby status: ${newStatus}`);
  }
}

function schedulePostMeetingPipeline(botId) {
  const id = String(botId);
  if (postMeetingPipelineQueued.has(id)) {
    console.log(`ℹ️  Post-meeting pipeline already queued for bot ${id} — skipping duplicate`);
    return;
  }
  postMeetingPipelineQueued.add(id);

  const delayMs = Math.max(0, parseInt(process.env.POST_MEETING_PIPELINE_DELAY_MS || '8000', 10) || 8000);

  setTimeout(async () => {
    try {
      const session = await skribby.getSessionByBotId(botId);
      if (!session) {
        console.warn(`⚠️  No DB session for bot: ${botId}`);
        return;
      }
      const summarySvc = require('./summaryService');
      if (await summarySvc.hasInProgressOrCompletedSummary(session.id)) {
        console.log(`ℹ️  Post-meeting skipped for ${id} — summary already exists or in progress`);
        return;
      }

      let recordingUrl = null;
      try {
        const bot = await skribby.getBot(botId);
        recordingUrl = bot.recording_url || null;
      } catch (e) {
        console.warn(`Could not fetch bot for recording URL: ${e.message}`);
      }

      const { processTranscriptAndSummarize } = require('../routes/skribby');
      await processTranscriptAndSummarize(session, recordingUrl);
    } catch (e) {
      console.error('Post-call processing failed:', e.message);
    } finally {
      postMeetingPipelineQueued.delete(id);
    }
  }, delayMs);
}

module.exports = {
  applySkribbyStatusUpdate,
  mapSkribbyToInternal,
  schedulePostMeetingPipeline,
};
