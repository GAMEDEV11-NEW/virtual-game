const { redis } = require('./redis');
const { toISOString, addMsToISO } = require('./dateUtils');
const cassandraClient = require('../services/cassandra/client');

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
// Gets user session from Redis cache or database
// ============================================================================
async function getSession(userId) {
  if (!userId) {
    return null;
  }

  const key = getSessionKey(userId);
  const data = await redis.get(key);

  if (data) {
    let session;
    if (typeof data === 'string') {
      try {
        session = JSON.parse(data);
      } catch (err) {
      }
    } else if (typeof data === 'object') {
      session = data;
    }

    if (session) {
      return parseSession(session);
    }
  }

  try {
    const query = `SELECT user_id, device_id, expires_at, fcm_token, is_active, jwt_token, mobile_no, session_token, updated_at, app_type, add_seen FROM sessions WHERE user_id = ?`;
    const result = await cassandraClient.execute(query, [userId], { prepare: true });

    if (result.rowLength === 0) {
      return null;
    }

    const row = result.first();
    if (!row.is_active) {
      return null;
    }

    const now = new Date();
    const expiresAt = row.expires_at ? row.expires_at.toISOString?.() || new Date(row.expires_at).toISOString() : '0001-01-01T00:00:00.000Z';

    const session = {
      session_token: row.session_token || '',
      mobile_no: row.mobile_no || '',
      user_id: row.user_id || userId,
      device_id: row.device_id || '',
      fcm_token: row.fcm_token || '',
      jwt_token: row.jwt_token || '',
      socket_id: '',
      is_active: row.is_active || false,
      created_at: row.updated_at?.toISOString?.() || now.toISOString(),
      expires_at: expiresAt,
      user_status: 'existing_user',
      connected_at: '0001-01-01T00:00:00.000Z',
      last_seen: now.toISOString(),
      user_agent: '',
      ip_address: '',
      namespace: '',
      app_type: row.app_type || '',
      add_seen: row.add_seen || 0
    };

    await redis.set(key, JSON.stringify(session));
    if (session.session_token && session.session_token !== userId) {
      await redis.set(getSessionKey(session.session_token), JSON.stringify(session));
    }

    return parseSession(session);
  } catch (err) {
    return null;
  }
}

// ============================================================================
// Fetches session directly from Cassandra and refreshes Redis cache
// ============================================================================
async function getSessionFromDb(userId) {
  if (!userId) {
    return null;
  }

  try {
    const query = `SELECT user_id, device_id, expires_at, fcm_token, is_active, jwt_token, mobile_no, session_token, updated_at, app_type, add_seen FROM sessions WHERE user_id = ?`;
    const result = await cassandraClient.execute(query, [userId], { prepare: true });

    if (result.rowLength === 0) {
      return null;
    }

    const row = result.first();
    if (!row.is_active) {
      return null;
    }

    const now = new Date();
    const expiresAt = row.expires_at ? row.expires_at.toISOString?.() || new Date(row.expires_at).toISOString() : '0001-01-01T00:00:00.000Z';

    const session = {
      session_token: row.session_token || '',
      mobile_no: row.mobile_no || '',
      user_id: row.user_id || userId,
      device_id: row.device_id || '',
      fcm_token: row.fcm_token || '',
      jwt_token: row.jwt_token || '',
      socket_id: '',
      is_active: row.is_active || false,
      created_at: row.updated_at?.toISOString?.() || now.toISOString(),
      expires_at: expiresAt,
      user_status: 'existing_user',
      connected_at: '0001-01-01T00:00:00.000Z',
      last_seen: now.toISOString(),
      user_agent: '',
      ip_address: '',
      namespace: '',
      app_type: row.app_type || '',
      add_seen: row.add_seen || 0
    };

    await redis.set(getSessionKey(userId), JSON.stringify(session));
    if (session.session_token && session.session_token !== userId) {
      await redis.set(getSessionKey(session.session_token), JSON.stringify(session));
    }

    return parseSession(session);
  } catch (err) {
    return null;
  }
}

// ============================================================================
// Updates session socket ID internally
// ============================================================================
async function updateSessionSocketIdInternal(userId, socketId) {
  const key = getSessionKey(userId);
  const session = await getSession(userId);
  if (!session) return false;
  if (!session.is_active) {
    return false;
  }
  session.socket_id = socketId;
  session.last_seen = toISOString();
  await redis.set(key, JSON.stringify(session));

  // Database UPDATE removed - sessions are now stored only in Redis

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
  const key = getSessionKey(sessionKeyId);
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

  await redis.set(key, JSON.stringify(session));
  if (session.session_token && session.session_token !== sessionKeyId) {
    await redis.set(getSessionKey(session.session_token), JSON.stringify(session));
  }

  // Database INSERT removed - sessions are now stored only in Redis

  return session;
}

// ============================================================================
// Clears user session from Redis
// ============================================================================
async function clearSession(userId) {
  if (!userId) {
    return false;
  }
  
  try {
    const key = getSessionKey(userId);
    const session = await getSession(userId);
    
    if (session) {
      // Delete by user_id
      await redis.del(key);
      
      // Also delete by session_token if different
      if (session.session_token && session.session_token !== userId) {
        await redis.del(getSessionKey(session.session_token));
      }
      
      // Delete lookup key
      await redis.del(`user_session_lookup:${userId}`);
    }
    
    return true;
  } catch (err) {
    return false;
  }
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
  getSessionFromDb,
  updateSessionSocketId,
  updateSessionSocketIdForReconnect,
  createSession,
  clearSession,
  clearSessionsForMatch,
  redis,
};
