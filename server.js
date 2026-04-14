// server.js  —  Main entry point
require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const path    = require('path');

const app  = express();
const PORT = process.env.PORT || 3001;

app.use(cors({ origin: '*', credentials: true }));
app.use(express.json({
  verify: (req, _res, buf) => {
    req.rawBody = buf.toString('utf8');
  },
}));
app.use(express.urlencoded({ extended: true }));

app.use(express.static(path.join(__dirname, 'public')));

app.use('/api/auth',    require('./src/routes/auth'));
app.use('/api/skribby', require('./src/routes/skribby'));
app.use('/api/zoom',       require('./src/routes/zoom'));
app.use('/api/google',     require('./src/routes/google'));
app.use('/api/microsoft',  require('./src/routes/microsoft'));
app.use('/api/meetings',   require('./src/routes/meetingsHub'));
app.use('/api/webhook',    require('./src/routes/webhook'));

app.get('/health', (_, res) => res.json({
  status: 'ok',
  skribby_api: process.env.SKRIBBY_API_BASE || 'https://platform.skribby.io/api/v1',
  bot_name: process.env.BOT_NAME,
  post_meeting_transcript_source: process.env.POST_MEETING_TRANSCRIPT_SOURCE || 'recording_openai_whisper',
  summary_after_transcription: !['false', '0', 'no'].includes(
    String(process.env.SUMMARY_AFTER_TRANSCRIPTION || 'true').toLowerCase()
  ),
  time: new Date().toISOString(),
}));

app.get('*', (_, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, () => {
  require('./src/services/skribbyPollService').start();

  console.log('');
  console.log('  ╔══════════════════════════════════════════════╗');
  console.log('  ║   🤖 Skribby + Zoom Summary Demo             ║');
  console.log('  ╠══════════════════════════════════════════════╣');
  console.log(`  ║   🌐 App        http://localhost:${PORT}         ║`);
  console.log('  ║   🤖 Skribby    platform.skribby.io          ║');
  console.log('  ║   📡 Webhook    /api/webhook/skribby (opt.)  ║');
  console.log('  ║   🔑 OAuth CB   zoom /google /microsoft      ║');
  console.log('  ║   📅 Hub        /api/meetings/upcoming       ║');
  console.log('  ╚══════════════════════════════════════════════╝');
  console.log('');
});

module.exports = app;
