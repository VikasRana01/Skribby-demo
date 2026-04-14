# Scheduled meetings: Zoom, Google Meet, Microsoft Teams

This document explains **how this demo lists upcoming meetings** from each platform, **what is free vs licensed**, and **how to configure OAuth**. There is **no single API** that returns all three with one login; each vendor uses its own OAuth app and scopes.

---

## Summary: “best” option for free / low friction

| Goal | Practical approach |
|------|---------------------|
| **List meetings tied to a user’s mailbox/calendar** | Use **calendar APIs** (Google Calendar, Microsoft Graph calendar), not “Meet-only” or “Teams-only” product APIs. |
| **Cheapest path for personal / dev testing** | **Google Calendar API** + **OAuth consent**: generous default quotas; Meet links appear on events that have a Meet conference. |
| **Zoom scheduled meetings** | **Zoom Meeting OAuth** (already in app): lists meetings created in Zoom for the connected user. **Free Zoom** accounts are limited for API features; many teams use **Pro** or higher for reliable API use. |
| **Microsoft Teams scheduled meetings** | **Microsoft Graph** `Calendars.Read` + **`/me/calendar/calendarView`**: Teams meetings are **calendar events** with an online meeting / join URL when created as Teams meetings. Requires **Azure app registration**; works for **Work/School** and many **personal** Microsoft accounts depending on tenant settings. |

**Important:** You do **not** get “all meetings for an email” without that user **consenting** via OAuth (or enterprise admin consent). There is no supported public API to pull another person’s calendar by email alone.

---

## How this project implements it

| Platform | Mechanism in code | Env vars |
|----------|-------------------|----------|
| **Zoom** | Zoom REST `GET /users/me/meetings` | `ZOOM_CLIENT_ID`, `ZOOM_CLIENT_SECRET`, `ZOOM_REDIRECT_URI` |
| **Google Meet (via Calendar)** | Google Calendar `GET /calendars/primary/events` → extract `hangoutLink` / Meet `entryPoints` | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI` |
| **Teams (via Graph calendar)** | Graph `GET /me/calendar/calendarView` → `onlineMeeting.joinUrl` or Teams link in body | `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET`, `MICROSOFT_REDIRECT_URI`, optional `MICROSOFT_TENANT_ID` (default `common`) |

**Unified endpoint (authenticated):**

- `GET /api/meetings/upcoming?days=14&sources=zoom,google,microsoft`  
  Returns `by_platform` and a time-sorted `merged` list. Google events are filtered to those with a **Meet link**; Microsoft entries prefer events that look like **Teams** meetings.

**Per-provider endpoints:**

- `GET /api/zoom/meetings?type=upcoming`
- `GET /api/google/events?days=14&meet_only=true`
- `GET /api/microsoft/events?days=14&teams_only=true`

---

## Skribby bot + join URL

Skribby accepts **`zoom`**, **`gmeet`**, and **`teams`** as `service` on **Create Bot**. This app **detects the platform from the URL** (`meetingPlatforms.js`) when you **Send Bot**.

Supported URL patterns (examples):

- Zoom: `https://zoom.us/j/...` (and common variants)
- Google Meet: `https://meet.google.com/...`
- Teams: `https://teams.microsoft.com/...` or `https://teams.live.com/...`

---

## Setup checklist

### 1. Google Cloud (Calendar + user email scope)

1. Create a project in [Google Cloud Console](https://console.cloud.google.com/).
2. **APIs & Services → Enable** “Google Calendar API”.
3. **Credentials → OAuth 2.0 Client ID** (Web application).  
   - Authorized redirect URI: `https://YOUR_HOST/api/google/callback`
4. **OAuth consent screen**: add scopes for Calendar readonly and (for profile email) the userinfo scope used in code.
5. Set `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI`, and `FRONTEND_URL` in `.env`.

### 2. Microsoft Azure (Graph calendar)

1. Register an app in [Azure Portal](https://portal.azure.com/) → **Microsoft Entra ID → App registrations**.
2. Add **Redirect URI** (Web): `https://YOUR_HOST/api/microsoft/callback`.
3. **Certificates & secrets**: create a client secret.
4. **API permissions** (delegated): `User.Read`, `Calendars.Read`, `offline_access`, `openid`, `profile`.  
   Grant admin consent if required by your tenant.
5. Set `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET`, `MICROSOFT_REDIRECT_URI`.  
   Use `MICROSOFT_TENANT_ID=common` for multi-tenant + personal accounts (default in code), or your tenant ID for single-tenant.

### 3. Zoom

Follow Zoom Marketplace **OAuth** app setup; redirect URI `https://YOUR_HOST/api/zoom/callback`. See Zoom docs for current **plan limits** on meeting list APIs.

### 4. Database

Run migrations so `google_tokens` and `microsoft_tokens` exist:

```bash
cd SkribbyDemo && npm run setup
```

---

## R&D notes / limitations

- **Google:** Events without a Meet conference will not appear in the **Meet-only** unified list (`meet_only=true`). All-day events use `date` instead of `dateTime`; display may show midnight UTC.
- **Microsoft:** Not every calendar event has a parseable Teams URL; the service checks `onlineMeeting.joinUrl`, `isOnlineMeeting`, `onlineMeetingProvider`, and a regex on the HTML body.
- **Zoom:** “Upcoming” is Zoom’s notion of scheduled meetings; it may differ from what appears in Outlook/Google Calendar for the same user.
- **Compliance:** Store refresh tokens encrypted at rest in production; rotate secrets; follow each vendor’s branding and data policies.

---

## References

- [Google Calendar API – Events](https://developers.google.com/calendar/api/v3/reference/events/list)
- [Microsoft Graph – calendarView](https://learn.microsoft.com/en-us/graph/api/calendar-list-calendarview)
- [Zoom – List meetings](https://developers.zoom.us/docs/api/rest/reference/zoom-api/methods/#operation/meetings)
- [Skribby – Create Bot (`service`: zoom, gmeet, teams)](https://skribby.io/docs/rest-api/openapi/bot-operations/createbot)
