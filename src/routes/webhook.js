// src/routes/webhook.js  —  Skribby webhook handler
const router   = require('express').Router();
const { verifySkribbySignature } = require('../middleware/verifySkribbyWebhook');
const { applySkribbyStatusUpdate } = require('../services/skribbyLifecycle');

router.post('/skribby', async (req, res) => {
  const check = verifySkribbySignature(req);
  if (!check.ok) {
    console.warn(`Skribby webhook rejected: ${check.reason}`);
    return res.status(401).json({ error: 'Invalid webhook signature' });
  }
  if (check.skipped) {
    console.warn('Skribby webhook: SKRIBBY_WEBHOOK_SECRET not set — signature not verified');
  }

  const body = req.body;
  const botId = body?.bot_id;

  console.log(`📩 Skribby webhook: ${body?.type} | bot: ${botId}`);

  res.status(200).json({ received: true });

  try {
    await handleSkribbyEvent(body, botId);
  } catch (err) {
    console.error(`❌ Skribby webhook handler error:`, err.message);
  }
});

async function handleSkribbyEvent(body, botId) {
  if (!botId) {
    console.warn('⚠️ Skribby webhook missing bot_id');
    return;
  }

  if (body.type !== 'status_update') {
    console.log(`ℹ️  Unhandled Skribby event type: ${body.type}`);
    return;
  }

  const { new_status: newStatus, stop_reason: stopReason } = body.data || {};
  if (!newStatus) return;

  await applySkribbyStatusUpdate(botId, newStatus, stopReason);
}

router.post('/zoom', async (req, res) => {
  const { event } = req.body;
  if (event === 'endpoint.url_validation') {
    const crypto = require('crypto');
    const hash = crypto
      .createHmac('sha256', process.env.ZOOM_WEBHOOK_SECRET_TOKEN)
      .update(req.body.payload.plainToken).digest('hex');
    return res.json({ plainToken: req.body.payload.plainToken, encryptedToken: hash });
  }
  res.status(200).json({ received: true });
});

module.exports = router;
