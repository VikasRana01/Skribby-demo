const router = require('express').Router();
const auth   = require('../middleware/auth');
const ms     = require('../services/microsoftGraphService');

router.get('/connect', auth, (req, res) => {
  if (!process.env.MICROSOFT_CLIENT_ID || !process.env.MICROSOFT_REDIRECT_URI)
    return res.status(503).json({ error: 'Microsoft OAuth is not configured' });
  res.json({ url: ms.getAuthUrl(req.user.id) });
});

router.delete('/disconnect', auth, async (req, res) => {
  await ms.disconnect(req.user.id);
  res.json({ success: true });
});

router.get('/callback', async (req, res) => {
  const { code, state, error, error_description } = req.query;
  const front = process.env.FRONTEND_URL || 'http://localhost:3001';
  if (error)
    return res.redirect(`${front}?microsoft_error=${encodeURIComponent(error_description || error)}`);
  try {
    const userId = parseInt(state, 10);
    const tokenData = await ms.exchangeCode(code);
    await ms.saveTokens(userId, tokenData);
    res.redirect(`${front}?microsoft_connected=true`);
  } catch (e) {
    console.error('Microsoft OAuth callback:', e.response?.data || e.message);
    res.redirect(`${front}?microsoft_error=failed`);
  }
});

router.get('/status', auth, async (req, res) => {
  try {
    const connected = await ms.isConnected(req.user.id);
    const profile = connected ? await ms.getStoredProfile(req.user.id) : null;
    res.json({
      connected,
      user: profile ? { email: profile.email, id: profile.ms_user_id } : null,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/events', auth, async (req, res) => {
  try {
    if (!(await ms.isConnected(req.user.id)))
      return res.status(403).json({ error: 'MICROSOFT_NOT_CONNECTED' });
    const days = Math.min(60, parseInt(req.query.days || '14', 10) || 14);
    const teamsOnly = req.query.teams_only === 'true' || req.query.teams_only === '1';
    const events = await ms.listUpcomingEvents(req.user.id, { days, teamsOnly });
    res.json({ success: true, events });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
