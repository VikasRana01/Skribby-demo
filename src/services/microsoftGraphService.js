// Microsoft Graph — calendar view with Teams online meetings (OAuth per user).
const axios = require('axios');
const pool  = require('../db');
require('dotenv').config();

const TENANT = process.env.MICROSOFT_TENANT_ID || 'common';
const AUTH = `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/authorize`;
const TOKEN_URL = `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`;
const GRAPH = 'https://graph.microsoft.com/v1.0';

const SCOPES = ['openid', 'profile', 'offline_access', 'User.Read', 'Calendars.Read'].join(' ');

function redirectUri() {
  return process.env.MICROSOFT_REDIRECT_URI;
}

function getAuthUrl(userId) {
  const params = new URLSearchParams({
    client_id:     process.env.MICROSOFT_CLIENT_ID,
    response_type: 'code',
    redirect_uri:  redirectUri(),
    response_mode: 'query',
    scope:         SCOPES,
    state:         String(userId),
  });
  return `${AUTH}?${params}`;
}

async function exchangeCode(code) {
  const { data } = await axios.post(TOKEN_URL, new URLSearchParams({
    client_id:     process.env.MICROSOFT_CLIENT_ID,
    client_secret: process.env.MICROSOFT_CLIENT_SECRET,
    code,
    redirect_uri:  redirectUri(),
    grant_type:    'authorization_code',
  }), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
  return data;
}

async function refreshToken(rt) {
  const { data } = await axios.post(TOKEN_URL, new URLSearchParams({
    client_id:     process.env.MICROSOFT_CLIENT_ID,
    client_secret: process.env.MICROSOFT_CLIENT_SECRET,
    grant_type:    'refresh_token',
    refresh_token: rt,
  }), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
  return data;
}

function extractTeamsUrl(event) {
  const j = event.onlineMeeting?.joinUrl;
  if (j && /teams\.(microsoft|live)\.com/i.test(j)) return j;
  const body = event.body?.content || '';
  const m = body.match(/https:\/\/teams\.(microsoft|live)\.com\/[^\s"'<>]+/i);
  if (m) return m[0].replace(/&amp;/g, '&');
  if (event.webLink && /teams\.microsoft\.com/i.test(event.webLink)) return event.webLink;
  return null;
}

function normalizeGraphEvent(event) {
  const start = event.start?.dateTime;
  const end = event.end?.dateTime;
  const joinUrl = extractTeamsUrl(event);
  const isTeams =
    Boolean(joinUrl) ||
    event.isOnlineMeeting === true ||
    String(event.onlineMeetingProvider || '').toLowerCase().includes('teams');
  return {
    id:         event.id,
    title:      event.subject || '(No title)',
    start,
    end,
    join_url:   joinUrl,
    platform:   'teams',
    has_video:  Boolean(joinUrl),
    is_teams_suspected: isTeams,
    raw_source: 'microsoft_graph',
  };
}

async function saveTokens(userId, tokenData) {
  const expiresAt = new Date(Date.now() + (tokenData.expires_in || 3600) * 1000);
  let email = null;
  let id = null;
  try {
    const { data } = await axios.get(`${GRAPH}/me`, {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });
    email = data.mail || data.userPrincipalName;
    id = data.id;
  } catch {}

  const rt = tokenData.refresh_token || null;
  await pool.query(
    `INSERT INTO microsoft_tokens (user_id, ms_user_id, email, access_token, refresh_token, expires_at, scope)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (user_id) DO UPDATE SET
       ms_user_id=$2, email=$3, access_token=$4,
       refresh_token=COALESCE(EXCLUDED.refresh_token, microsoft_tokens.refresh_token),
       expires_at=$5, scope=$6, updated_at=NOW()`,
    [userId, id, email, tokenData.access_token, rt, expiresAt, tokenData.scope || SCOPES]
  );
}

async function getValidToken(userId) {
  const { rows } = await pool.query('SELECT * FROM microsoft_tokens WHERE user_id=$1', [userId]);
  if (!rows.length) throw new Error('MICROSOFT_NOT_CONNECTED');
  const row = rows[0];
  if (new Date(row.expires_at) - Date.now() < 5 * 60 * 1000) {
    if (!row.refresh_token) throw new Error('MICROSOFT_REFRESH_MISSING');
    const newTok = await refreshToken(row.refresh_token);
    await saveTokens(userId, { ...newTok, refresh_token: newTok.refresh_token || row.refresh_token });
    return newTok.access_token;
  }
  return row.access_token;
}

async function listUpcomingEvents(userId, { days = 14, teamsOnly = false } = {}) {
  const token = await getValidToken(userId);
  const start = new Date().toISOString();
  const end = new Date(Date.now() + days * 86400000).toISOString();
  const { data } = await axios.get(`${GRAPH}/me/calendar/calendarView`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Prefer:        'outlook.timezone="UTC"',
    },
    params: {
      startDateTime: start,
      endDateTime:   end,
      $top:          50,
    },
  });
  let items = (data.value || []).map(normalizeGraphEvent);
  if (teamsOnly) items = items.filter((x) => x.join_url || x.is_teams_suspected);
  return items;
}

async function isConnected(userId) {
  const { rows } = await pool.query('SELECT 1 FROM microsoft_tokens WHERE user_id=$1', [userId]);
  return rows.length > 0;
}

async function disconnect(userId) {
  await pool.query('DELETE FROM microsoft_tokens WHERE user_id=$1', [userId]);
}

async function getStoredProfile(userId) {
  const { rows } = await pool.query(
    'SELECT email, ms_user_id FROM microsoft_tokens WHERE user_id=$1',
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
