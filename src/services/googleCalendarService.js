// Google Calendar API — list events with Google Meet links (OAuth per user).
const axios = require('axios');
const pool  = require('../db');
require('dotenv').config();

const AUTH = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const CAL = 'https://www.googleapis.com/calendar/v3';

const SCOPES = [
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/userinfo.email',
].join(' ');

function redirectUri() {
  return process.env.GOOGLE_REDIRECT_URI;
}

function getAuthUrl(userId) {
  const params = new URLSearchParams({
    client_id:     process.env.GOOGLE_CLIENT_ID,
    redirect_uri:  redirectUri(),
    response_type: 'code',
    scope:         SCOPES,
    access_type:   'offline',
    prompt:        'consent',
    state:         String(userId),
  });
  return `${AUTH}?${params}`;
}

async function exchangeCode(code) {
  const { data } = await axios.post(TOKEN_URL, new URLSearchParams({
    code,
    client_id:     process.env.GOOGLE_CLIENT_ID,
    client_secret: process.env.GOOGLE_CLIENT_SECRET,
    redirect_uri:  redirectUri(),
    grant_type:    'authorization_code',
  }), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
  return data;
}

async function refreshToken(rt) {
  const { data } = await axios.post(TOKEN_URL, new URLSearchParams({
    client_id:     process.env.GOOGLE_CLIENT_ID,
    client_secret: process.env.GOOGLE_CLIENT_SECRET,
    grant_type:    'refresh_token',
    refresh_token: rt,
  }), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
  return data;
}

function extractMeetUrl(event) {
  if (event.hangoutLink) return event.hangoutLink;
  const eps = event.conferenceData?.entryPoints || [];
  for (const e of eps) {
    if (e.uri && /meet\.google\.com\//i.test(e.uri)) return e.uri;
  }
  return null;
}

function normalizeGoogleEvent(event) {
  const start = event.start?.dateTime || event.start?.date;
  const end = event.end?.dateTime || event.end?.date;
  const joinUrl = extractMeetUrl(event);
  return {
    id:         event.id,
    title:      event.summary || '(No title)',
    start,
    end,
    join_url:   joinUrl,
    platform:   'google_meet',
    has_video:  Boolean(joinUrl),
    raw_source: 'google_calendar',
  };
}

async function saveTokens(userId, tokenData) {
  const expiresAt = new Date(Date.now() + (tokenData.expires_in || 3600) * 1000);
  let email = null;
  let sub = null;
  try {
    const { data } = await axios.get('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });
    email = data.email;
    sub = data.id;
  } catch {}

  const rt = tokenData.refresh_token || null;
  await pool.query(
    `INSERT INTO google_tokens (user_id, google_user_id, email, access_token, refresh_token, expires_at, scope)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (user_id) DO UPDATE SET
       google_user_id=$2, email=$3, access_token=$4,
       refresh_token=COALESCE(EXCLUDED.refresh_token, google_tokens.refresh_token),
       expires_at=$5, scope=$6, updated_at=NOW()`,
    [userId, sub, email, tokenData.access_token, rt, expiresAt, tokenData.scope || SCOPES]
  );
}

async function getValidToken(userId) {
  const { rows } = await pool.query('SELECT * FROM google_tokens WHERE user_id=$1', [userId]);
  if (!rows.length) throw new Error('GOOGLE_NOT_CONNECTED');
  const row = rows[0];
  if (new Date(row.expires_at) - Date.now() < 5 * 60 * 1000) {
    if (!row.refresh_token) throw new Error('GOOGLE_REFRESH_MISSING');
    const newTok = await refreshToken(row.refresh_token);
    await saveTokens(userId, { ...newTok, refresh_token: newTok.refresh_token || row.refresh_token });
    return newTok.access_token;
  }
  return row.access_token;
}

/**
 * Upcoming calendar events (optionally filter to those with a Meet link).
 */
async function listUpcomingEvents(userId, { days = 14, meetOnly = false } = {}) {
  const token = await getValidToken(userId);
  const timeMin = new Date().toISOString();
  const timeMax = new Date(Date.now() + days * 86400000).toISOString();
  const { data } = await axios.get(`${CAL}/calendars/primary/events`, {
    headers: { Authorization: `Bearer ${token}` },
    params: {
      timeMin,
      timeMax,
      singleEvents: true,
      orderBy:      'startTime',
      maxResults:   50,
    },
  });
  const items = (data.items || []).map(normalizeGoogleEvent);
  if (meetOnly) return items.filter((x) => x.join_url);
  return items;
}

async function isConnected(userId) {
  const { rows } = await pool.query('SELECT 1 FROM google_tokens WHERE user_id=$1', [userId]);
  return rows.length > 0;
}

async function disconnect(userId) {
  await pool.query('DELETE FROM google_tokens WHERE user_id=$1', [userId]);
}

async function getStoredProfile(userId) {
  const { rows } = await pool.query(
    'SELECT email, google_user_id FROM google_tokens WHERE user_id=$1',
    [userId]
  );
  return rows[0] || null;
}

module.exports = {
  getAuthUrl,
  exchangeCode,
  saveTokens,
  getValidToken,
  listUpcomingEvents,
  isConnected,
  disconnect,
  getStoredProfile,
};
