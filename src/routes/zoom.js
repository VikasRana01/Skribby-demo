// src/routes/zoom.js  —  Zoom OAuth for listing meetings
const router = require('express').Router();
const auth   = require('../middleware/auth');
const zoom   = require('../services/zoomService');

router.get('/connect',    auth, (req, res) => res.json({ url: zoom.getAuthUrl(req.user.id) }));
router.delete('/disconnect', auth, async (req, res) => {
  await zoom.disconnect(req.user.id);
  res.json({ success: true });
});

router.get('/callback', async (req, res) => {
  const { code, state, error } = req.query;
  const front = process.env.FRONTEND_URL || 'http://localhost:3001';
  if (error) return res.redirect(`${front}?zoom_error=${error}`);
  try {
    const userId = parseInt(state);
    console.log(`🔑 Zoom callback — code: ${code?.slice(0, 8)}... state/userId: ${userId}`);
    const tokenData = await zoom.exchangeCode(code);
    console.log(`✅ Token exchanged — scope: ${tokenData.scope}`);
    await zoom.saveTokens(userId, tokenData);
    console.log(`✅ Zoom connected for userId: ${userId}`);
    res.redirect(`${front}?zoom_connected=true`);
  } catch (e) {
    const detail = e.response?.data || e.message;
    console.error(`❌ Zoom OAuth callback failed:`, JSON.stringify(detail, null, 2));
    res.redirect(`${front}?zoom_error=failed&reason=${encodeURIComponent(JSON.stringify(detail))}`);
  }
});

router.get('/status', auth, async (req, res) => {
  try {
    const connected = await zoom.isConnected(req.user.id);
    let zoomUser = null;
    if (connected) {
      const t = await zoom.getValidToken(req.user.id);
      const u = await zoom.getZoomUser(t);
      zoomUser = { id: u.id, email: u.email, display_name: u.display_name };
    }
    res.json({ connected, zoomUser });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/meetings', auth, async (req, res) => {
  try {
    if (!await zoom.isConnected(req.user.id))
      return res.status(403).json({ error: 'ZOOM_NOT_CONNECTED' });
    const meetings = await zoom.getMeetings(req.user.id, req.query.type || 'upcoming');
    res.json({ success: true, meetings });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
