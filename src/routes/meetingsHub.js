// Aggregated upcoming meetings from Zoom + Google Calendar + Microsoft Graph (each optional).
const router = require('express').Router();
const auth = require('../middleware/auth');
const zoom = require('../services/zoomService');
const google = require('../services/googleCalendarService');
const ms = require('../services/microsoftGraphService');
const calendarSync = require('../services/calendarMeetingSyncService');

router.get('/upcoming', auth, async (req, res) => {
  const days = Math.min(60, parseInt(req.query.days || '14', 10) || 14);
  const sources = (req.query.sources || 'zoom,google,microsoft')
    .toLowerCase()
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  const auto = ['1', 'true', 'yes'].includes(String(req.query.auto_schedule || '').toLowerCase());

  try {
    if (auto) {
      const r = await calendarSync.syncAndScheduleMeetings(req.user.id, days, sources);
      return res.json({
        success: true,
        days,
        by_platform: r.by,
        merged:      r.merged,
        errors:      r.errors.length ? r.errors : undefined,
        sync_meta:   r.sync_meta,
      });
    }

    const { by, merged, errors } = await calendarSync.fetchProviderMeetings(req.user.id, days, sources);
    res.json({
      success: true,
      days,
      by_platform: by,
      merged,
      errors: errors.length ? errors : undefined,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/connections', auth, async (req, res) => {
  const [z, g, m] = await Promise.all([
    zoom.isConnected(req.user.id),
    google.isConnected(req.user.id),
    ms.isConnected(req.user.id),
  ]);
  res.json({
    zoom: z,
    google: g,
    microsoft: m,
  });
});

module.exports = router;
