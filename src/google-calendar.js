const { findAvailableSlots } = require('./booking');

const API_ROOT = 'https://www.googleapis.com/calendar/v3';
let cachedAccessToken;
let cachedAccessTokenExpiresAt = 0;

async function getAccessToken(fetchImpl) {
  if (
    fetchImpl === global.fetch &&
    cachedAccessToken &&
    cachedAccessTokenExpiresAt > Date.now() + 30_000
  ) return cachedAccessToken;

  const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN } = process.env;
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !GOOGLE_REFRESH_TOKEN) {
    throw new Error('Google Calendar OAuth is not configured.');
  }
  const body = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    client_secret: GOOGLE_CLIENT_SECRET,
    refresh_token: GOOGLE_REFRESH_TOKEN,
    grant_type: 'refresh_token',
  });
  const response = await fetchImpl('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
    signal: AbortSignal.timeout(8000),
  });
  const data = await response.json();
  if (!response.ok || typeof data.access_token !== 'string') {
    throw new Error(`Google OAuth token refresh failed with status ${response.status}.`);
  }
  if (fetchImpl === global.fetch) {
    cachedAccessToken = data.access_token;
    cachedAccessTokenExpiresAt = Date.now() + Number(data.expires_in || 3600) * 1000;
  }
  return data.access_token;
}

async function calendarRequest(path, { method = 'GET', body, fetchImpl = global.fetch } = {}) {
  const token = await getAccessToken(fetchImpl);
  const response = await fetchImpl(`${API_ROOT}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(8000),
  });
  const data = await response.json();
  if (!response.ok) {
    throw new Error(`Google Calendar request failed with status ${response.status}.`);
  }
  return data;
}

async function getBusyPeriods(from, to, fetchImpl = global.fetch) {
  const data = await calendarRequest('/freeBusy', {
    method: 'POST',
    body: {
      timeMin: from.toISOString(),
      timeMax: to.toISOString(),
      timeZone: 'America/Chicago',
      items: [{ id: process.env.GOOGLE_CALENDAR_ID || 'primary' }],
    },
    fetchImpl,
  });
  const calendarId = process.env.GOOGLE_CALENDAR_ID || 'primary';
  const calendar = data.calendars?.[calendarId];
  if (!calendar || calendar.errors?.length) {
    throw new Error('Google Calendar did not return availability for the configured calendar.');
  }
  return calendar.busy || [];
}

async function suggestSlots(callStartedAt, now = new Date(), fetchImpl = global.fetch) {
  const horizon = new Date(now.getTime() + 14 * 24 * 60 * 60_000);
  const busy = await getBusyPeriods(now, horizon, fetchImpl);
  return findAvailableSlots(busy, now, callStartedAt);
}

async function createBooking(session, slot, fetchImpl = global.fetch) {
  const calendarId = encodeURIComponent(process.env.GOOGLE_CALENDAR_ID || 'primary');
  const id = require('node:crypto').createHash('sha256')
    .update(`${session.call_sid}:${slot.start}`)
    .digest('hex');
  const body = {
    id,
    summary: `${session.service_type} - ${session.customer_name}`,
    description: `Booked through HootOwl. Caller: ${session.caller_number}. ${session.issue_description}`,
    location: session.service_address,
    start: { dateTime: slot.start, timeZone: 'America/Chicago' },
    end: { dateTime: slot.end, timeZone: 'America/Chicago' },
    extendedProperties: { private: { hootowlCallSid: session.call_sid } },
  };

  try {
    const event = await calendarRequest(`/calendars/${calendarId}/events`, {
      method: 'POST',
      body,
      fetchImpl,
    });
    return { eventId: event.id, event };
  } catch (error) {
    if (!/status 409/.test(error.message)) throw error;
    const event = await calendarRequest(`/calendars/${calendarId}/events/${id}`, { fetchImpl });
    if (event.extendedProperties?.private?.hootowlCallSid !== session.call_sid) {
      throw new Error('Google Calendar returned an event ID conflict for a different booking.');
    }
    return { eventId: event.id, event };
  }
}

async function isSlotAvailable(slot, fetchImpl = global.fetch) {
  const buffer = 10 * 60_000;
  const from = new Date(new Date(slot.start).getTime() - buffer);
  const to = new Date(new Date(slot.end).getTime() + buffer);
  const busy = await getBusyPeriods(from, to, fetchImpl);
  return !busy.some((period) =>
    from.getTime() < new Date(period.end).getTime() &&
    to.getTime() > new Date(period.start).getTime(),
  );
}

module.exports = { createBooking, getBusyPeriods, isSlotAvailable, suggestSlots };
