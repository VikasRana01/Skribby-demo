const router = require('express').Router();
const auth   = require('../middleware/auth');
const google = require('../services/googleCalendarService');

router.get('/connect', auth, (req, res) => {
  if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_REDIRECT_URI)
    return res.status(503).json({ error: 'Google Calendar OAuth is not configured' });
  res.json({ url: google.getAuthUrl(req.user.id) });
});

router.delete('/disconnect', auth, async (req, res) => {
  await google.disconnect(req.user.id);
  res.json({ success: true });
});

router.get('/callback', async (req, res) => {
  const { code, state, error } = req.query;
  const front = process.env.FRONTEND_URL || 'http://localhost:3001';
  if (error) return res.redirect(`${front}?google_error=${encodeURIComponent(error)}`);
  try {
    const userId = parseInt(state, 10);
    const tokenData = await google.exchangeCode(code);
    await google.saveTokens(userId, tokenData);
    res.redirect(`${front}?google_connected=true`);
  } catch (e) {
    console.error('Google OAuth callback:', e.response?.data || e.message);
    res.redirect(`${front}?google_error=failed`);
  }
});

router.get('/status', auth, async (req, res) => {
  try {
    const connected = await google.isConnected(req.user.id);
    const profile = connected ? await google.getStoredProfile(req.user.id) : null;
    res.json({
      connected,
      user: profile ? { email: profile.email, id: profile.google_user_id } : null,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/events', auth, async (req, res) => {
  try {
    if (!(await google.isConnected(req.user.id)))
      return res.status(403).json({ error: 'GOOGLE_NOT_CONNECTED' });
    const days = Math.min(60, parseInt(req.query.days || '14', 10) || 14);
    const meetOnly = req.query.meet_only === 'true' || req.query.meet_only === '1';
    const events = await google.listUpcomingEvents(req.user.id, { days, meetOnly });
    res.json({ success: true, events });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
