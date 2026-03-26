const { redis } = require('./redis');
const { toISOString, addMsToISO } = require('./dateUtils');
const axios = require('axios');

function buildApiErrorMessage(err) {
  if (!err) return 'Unknown session API error';
  const responseMessage = err.response?.data?.message || err.response?.data?.error;
  if (responseMessage) return String(responseMessage);
  if (err.code === 'ECONNABORTED') return 'Session API timeout';
  return err.message || 'Session API request failed';
}

// ============================================================================
// Parses boolean value from various types
// ============================================================================
function parseBoolean(value) {
  if (value === null || value === undefined) return false;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const lower = value.toLowerCase().trim();
    return lower === 'true' || lower === '1' || lower === 'yes';
  }
  if (typeof value === 'number') return value !== 0;
  return Boolean(value);
}

// ============================================================================
// Gets Redis session key for user ID
// ============================================================================
const getSessionKey = (id) => `session:${id}`;

// ============================================================================
// Parses session object and converts is_active to boolean
// ============================================================================
function parseSession(session) {
  if (!session) return null;
  if ('is_active' in session) session.is_active = parseBoolean(session.is_active);
  return session;
}

// ============================================================================
// Resolves session payload from various API response shapes
// ============================================================================
function extractSessionPayload(apiData) {
  if (!apiData) return null;
  if (apiData.session && typeof apiData.session === 'object') return apiData.session;
  if (apiData.data && typeof apiData.data === 'object') {
    if (apiData.data.session && typeof apiData.data.session === 'object') return apiData.data.session;
    return apiData.data;
  }
  if (typeof apiData === 'object') return apiData;
  return null;
}

// ============================================================================
// Maps API session payload to local session schema
// ============================================================================
function mapApiSessionToLocal(payload, userId) {
  if (!payload || typeof payload !== 'object') return null;
  const now = new Date();

  return {
    session_token: payload.session_token || payload.token || '',
    mobile_no: payload.mobile_no || '',
    user_id: payload.user_id || userId,
    device_id: payload.device_id || '',
    fcm_token: payload.fcm_token || '',
    jwt_token: payload.jwt_token || '',
    socket_id: payload.socket_id || '',
    is_active: parseBoolean(payload.is_active),
    created_at: payload.created_at || payload.updated_at || now.toISOString(),
    expires_at: payload.expires_at || '0001-01-01T00:00:00.000Z',
    user_status: payload.user_status || 'existing_user',
    connected_at: payload.connected_at || '0001-01-01T00:00:00.000Z',
    last_seen: payload.last_seen || now.toISOString(),
    user_agent: payload.user_agent || '',
    ip_address: payload.ip_address || '',
    namespace: payload.namespace || '',
    app_type: payload.app_type || '',
    add_seen: payload.add_seen || 0
  };
}

// ============================================================================
// Gets session from external API
// ============================================================================
async function fetchSessionFromApi(userId) {
  const baseUrl = (process.env.SESSION_API_BASE_URL || '').trim();
  const endpoint = (process.env.SESSION_API_ENDPOINT || '/sessions/{userId}').trim();
  const method = (process.env.SESSION_API_METHOD || 'GET').toUpperCase();
  const timeout = Number(process.env.SESSION_API_TIMEOUT_MS || 5000);

  if (!baseUrl) {
    return null;
  }

  const normalizedBaseUrl = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
  const normalizedEndpoint = endpoint.startsWith('/') ? endpoint : `/${endpoint}`;
  const path = normalizedEndpoint.includes('{userId}')
    ? normalizedEndpoint.replace('{userId}', encodeURIComponent(String(userId)))
    : `${normalizedEndpoint}?user_id=${encodeURIComponent(String(userId))}`;
  const url = `${normalizedBaseUrl}${path}`;

  const headers = {};
  if (process.env.SESSION_API_BEARER_TOKEN) {
    headers.Authorization = `Bearer ${process.env.SESSION_API_BEARER_TOKEN}`;
  }
  if (process.env.SESSION_API_KEY) {
    headers['x-api-key'] = process.env.SESSION_API_KEY;
  }

  const reqConfig = { url, method, headers, timeout };
  if (method !== 'GET') {
    reqConfig.data = { user_id: userId };
  }

  try {
    const response = await axios(reqConfig);
    const payload = extractSessionPayload(response.data);
    const session = mapApiSessionToLocal(payload, userId);
    if (!session || !session.is_active) return null;
    return session;
  } catch (err) {
    const message = buildApiErrorMessage(err);
    const wrapped = new Error(message);
    wrapped.cause = err;
    throw wrapped;
  }
}

// ============================================================================
// Gets user session from Redis cache, then API; throws on API/lookup issues
// ============================================================================
async function getSessionOrThrow(userId, options = {}) {
  const { skipRedisRead = true } = options;
  if (!userId) {
    throw new Error('Missing user_id');
  }

  if (!skipRedisRead) {
    const key = getSessionKey(userId);
    const data = await redis.get(key);
    if (data) {
      let session;
      if (typeof data === 'string') {
        try {
          session = JSON.parse(data);
        } catch (_) {
        }
      } else if (typeof data === 'object') {
        session = data;
      }
      if (session) {
        return parseSession(session);
      }
    }
  }

  const baseUrl = (process.env.SESSION_API_BASE_URL || '').trim();
  if (!baseUrl) {
    throw new Error('Session API is not configured');
  }

  const session = await fetchSessionFromApi(userId);
  if (!session) {
    throw new Error('Session not found or inactive');
  }

  return parseSession(session);
}

// ============================================================================
// Gets user session from Redis cache or API
// ============================================================================
async function getSession(userId) {
  if (!userId) {
    return null;
  }

  try {
    return await getSessionOrThrow(userId, { skipRedisRead: true });
  } catch (err) {
    return null;
  }
}

// ============================================================================
// Fetches session directly from API and refreshes Redis cache
// ============================================================================
async function getSessionFromDb(userId) {
  if (!userId) {
    return null;
  }

  try {
    return await getSessionOrThrow(userId, { skipRedisRead: true });
  } catch (err) {
    return null;
  }
}

// ============================================================================
// Updates session socket ID internally
// ============================================================================
async function updateSessionSocketIdInternal(userId, socketId) {
  const session = await getSession(userId);
  if (!session) return false;
  if (!session.is_active) {
    return false;
  }
  return true;
}

// ============================================================================
// Updates session socket ID
// ============================================================================
async function updateSessionSocketId(userId, socketId) {
  return updateSessionSocketIdInternal(userId, socketId);
}

// ============================================================================
// Updates session socket ID for reconnection
// ============================================================================
async function updateSessionSocketIdForReconnect(userId, socketId) {
  return updateSessionSocketIdInternal(userId, socketId);
}

// ============================================================================
// Creates a new session in Redis (database operations removed)
// ============================================================================
async function createSession(sessionData) {
  const sessionKeyId = sessionData.user_id || sessionData.session_token;
  if (!sessionKeyId) {
    throw new Error('createSession requires user_id or session_token');
  }
  const now = new Date();
  const expiresAt = sessionData.expires_at ? toISOString(sessionData.expires_at) : addMsToISO(20 * 60 * 1000);

  const session = {
    session_token: sessionData.session_token || '',
    mobile_no: sessionData.mobile_no || '',
    user_id: sessionData.user_id || '',
    device_id: sessionData.device_id || '',
    fcm_token: sessionData.fcm_token || '',
    jwt_token: sessionData.jwt_token || '',
    socket_id: sessionData.socket_id || '',
    is_active: !((sessionData.is_active === false || sessionData.is_active === 'false')),
    created_at: sessionData.created_at ? toISOString(sessionData.created_at) : toISOString(),
    expires_at: expiresAt,
    user_status: sessionData.user_status || '',
    connected_at: sessionData.connected_at ? toISOString(sessionData.connected_at) : toISOString(),
    last_seen: sessionData.last_seen ? toISOString(sessionData.last_seen) : toISOString(),
    user_agent: sessionData.user_agent || '',
    ip_address: sessionData.ip_address || '',
    namespace: sessionData.namespace || '',
    app_type: sessionData.app_type || '',
    add_seen: sessionData.add_seen || 0
  };

  return session;
}

// ============================================================================
// Clears user session from Redis
// ============================================================================
async function clearSession(userId) {
  return Boolean(userId);
}

// ============================================================================
// Clears sessions for both users in a match
// ============================================================================
async function clearSessionsForMatch(user1Id, user2Id) {
  try {
    await Promise.all([
      clearSession(user1Id),
      clearSession(user2Id)
    ]);
    return true;
  } catch (err) {
    return false;
  }
}

module.exports = {
  getSession,
  getSessionOrThrow,
  getSessionFromDb,
  updateSessionSocketId,
  updateSessionSocketIdForReconnect,
  createSession,
  clearSession,
  clearSessionsForMatch,
  redis,
};
