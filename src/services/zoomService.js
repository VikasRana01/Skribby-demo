// src/services/zoomService.js  —  Zoom OAuth + meeting listing
const axios = require('axios');
const pool  = require('../db');
require('dotenv').config();

const BASE = 'https://api.zoom.us/v2';
const AUTH = 'https://zoom.us/oauth';
const creds = () => Buffer.from(`${process.env.ZOOM_CLIENT_ID}:${process.env.ZOOM_CLIENT_SECRET}`).toString('base64');

function getAuthUrl(userId) {
  return `${AUTH}/authorize?` + new URLSearchParams({
    response_type: 'code',
    client_id:     process.env.ZOOM_CLIENT_ID,
    redirect_uri:  process.env.ZOOM_REDIRECT_URI,
    state:         String(userId),
    scope:         'user:read:user meeting:read:list_meetings meeting:read:meeting',
  });
}

async function exchangeCode(code) {
  const { data } = await axios.post(`${AUTH}/token`,
    new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: process.env.ZOOM_REDIRECT_URI }),
    { headers: { Authorization: `Basic ${creds()}`, 'Content-Type': 'application/x-www-form-urlencoded' } }
  );
  return data;
}

async function refreshToken(rt) {
  const { data } = await axios.post(`${AUTH}/token`,
    new URLSearchParams({ grant_type: 'refresh_token', refresh_token: rt }),
    { headers: { Authorization: `Basic ${creds()}`, 'Content-Type': 'application/x-www-form-urlencoded' } }
  );
  return data;
}

async function getZoomUser(token) {
  const { data } = await axios.get(`${BASE}/users/me`, { headers: { Authorization: `Bearer ${token}` } });
  return data;
}

async function saveTokens(userId, tokenData) {
  const expiresAt = new Date(Date.now() + tokenData.expires_in * 1000);
  const u = await getZoomUser(tokenData.access_token);
  await pool.query(
    `INSERT INTO zoom_tokens (user_id, zoom_user_id, access_token, refresh_token, expires_at, scope)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (user_id) DO UPDATE SET
       zoom_user_id=$2, access_token=$3, refresh_token=$4, expires_at=$5, scope=$6, updated_at=NOW()`,
    [userId, u.id, tokenData.access_token, tokenData.refresh_token, expiresAt, tokenData.scope]
  );
  return u;
}

async function getValidToken(userId) {
  const { rows } = await pool.query('SELECT * FROM zoom_tokens WHERE user_id=$1', [userId]);
  if (!rows.length) throw new Error('ZOOM_NOT_CONNECTED');
  const row = rows[0];
  if (new Date(row.expires_at) - Date.now() < 5 * 60 * 1000) {
    const newTok = await refreshToken(row.refresh_token);
    await saveTokens(userId, newTok);
    return newTok.access_token;
  }
  return row.access_token;
}

async function getMeetings(userId, type = 'upcoming') {
  const token = await getValidToken(userId);
  const { data } = await axios.get(`${BASE}/users/me/meetings`, {
    headers: { Authorization: `Bearer ${token}` },
    params: { type, page_size: 30 },
  });
  return data.meetings || [];
}

async function isConnected(userId) {
  const { rows } = await pool.query('SELECT id FROM zoom_tokens WHERE user_id=$1', [userId]);
  return rows.length > 0;
}

async function disconnect(userId) {
  const { rows } = await pool.query('SELECT access_token FROM zoom_tokens WHERE user_id=$1', [userId]);
  if (rows.length) {
    try {
      await axios.post(`${AUTH}/revoke`, new URLSearchParams({ token: rows[0].access_token }),
        { headers: { Authorization: `Basic ${creds()}` } });
    } catch {}
    await pool.query('DELETE FROM zoom_tokens WHERE user_id=$1', [userId]);
  }
}

module.exports = { getAuthUrl, exchangeCode, saveTokens, getValidToken, getZoomUser, getMeetings, isConnected, disconnect };
