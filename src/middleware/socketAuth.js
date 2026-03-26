const sessionService = require('../utils/sessionService');
const { redis } = require('../utils/redis');
const mysqlClient = require('../services/mysql/client');
const { REDIS_KEYS, DB_QUERIES } = require('../constants');
const { config } = require('../utils/config');
const axios = require('axios');

function pickContestRecord(contestJoinData, contestId) {
  if (!contestJoinData) return null;
  if (Array.isArray(contestJoinData)) {
    if (contestId) {
      const matched = contestJoinData.find((row) => String(row?.contest_id || row?.league_id || '') === String(contestId));
      if (matched) return matched;
    }
    return contestJoinData[0] || null;
  }
  return contestJoinData;
}

function buildContestSnapshot(userId, contestId, rawRecord, clientLid = '') {
  const record = rawRecord || {};
  const resolvedContestId = record.contest_id || record.league_id || contestId || '';
  const resolvedLid = normalizeString(clientLid) || record.l_id || record.id || '';
  return {
    user_id: String(userId),
    contest_id: String(resolvedContestId),
    league_id: record.league_id ? String(record.league_id) : '',
    l_id: resolvedLid,
    game_type: record.game_type || '',
    contest_type: record.contest_type || '',
    entry_fee: record.entry_fee ?? null,
    joined_at: record.joined_at || '',
    status: record.status || '',
    status_id: record.status_id || '',
    opponent_user_id: record.opponent_user_id || '',
    opponent_league_id: record.opponent_league_id || '',
    match_pair_id: record.match_pair_id || '',
    turn_id: record.turn_id || '',
    extra_data: record.extra_data || null,
    fetched_at: new Date().toISOString()
  };
}

function buildContestJoinRedisKey(snapshot) {
  const userId = normalizeString(snapshot?.user_id);
  const contestId = normalizeString(snapshot?.contest_id || snapshot?.league_id);
  const lid = normalizeString(snapshot?.l_id);
  return `contest_join:${userId}:${contestId}:${lid}`;
}

function normalizeString(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

function generateLid(userId, leagueId) {
  return `lj_${normalizeString(userId)}_${normalizeString(leagueId || '0')}`;
}

function toJoinDay(isoDate) {
  const d = isoDate ? new Date(isoDate) : new Date();
  return d.toISOString().slice(0, 10);
}

function toMySqlDateTime(value) {
  const d = value ? new Date(value) : new Date();
  if (Number.isNaN(d.getTime())) return null;
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mi = String(d.getUTCMinutes()).padStart(2, '0');
  const ss = String(d.getUTCSeconds()).padStart(2, '0');
  const ms = String(d.getUTCMilliseconds()).padStart(3, '0');
  return `${yyyy}-${mm}-${dd} ${hh}:${mi}:${ss}.${ms}`;
}

async function persistPendingJoinBackground(snapshot) {
  const userId = normalizeString(snapshot?.user_id);
  const contestId = normalizeString(snapshot?.contest_id || snapshot?.league_id);
  const leagueId = normalizeString(snapshot?.league_id || snapshot?.contest_id);
  if (!userId || !contestId || !leagueId) return;

  const joinedAtRaw = snapshot?.joined_at || new Date().toISOString();
  const joinedAtMysql = toMySqlDateTime(joinedAtRaw) || toMySqlDateTime(new Date().toISOString());
  const joinDay = toJoinDay(joinedAtRaw);
  const lId = normalizeString(snapshot?.l_id) || generateLid(userId, leagueId);
  const gameType = normalizeString(snapshot?.game_type || 'ludo');
  const contestType = normalizeString(snapshot?.contest_type || 'simple');
  const serverId = normalizeString(config.serverId || '0');

  try {
    const [existingRows] = await mysqlClient.execute(DB_QUERIES.LUDO_SELECT_JOIN_BY_LID, [lId]);
    if (Array.isArray(existingRows) && existingRows.length > 0) {
      const currentStatus = normalizeString(existingRows[0]?.status).toLowerCase();
      if (currentStatus && currentStatus !== 'pending') {
        // Do not downgrade matched/active/completed/expired rows back to pending on reconnect.
        return;
      }
    }

    await mysqlClient.execute(DB_QUERIES.LUDO_UPSERT_PENDING_FROM_SOCKET, [
      lId,
      userId,
      contestId,
      leagueId,
      joinedAtMysql,
      joinDay,
      'pending',
      '1',
      gameType,
      contestType,
      serverId
    ]);
  } catch (err) {
    console.error('[SocketAuth] pending upsert failed:', {
      message: err?.message || String(err),
      userId,
      contestId,
      leagueId,
      lId,
      joinedAtMysql
    });
  }
}

async function validateLidUniquenessOrThrow({ userId, contestId, lId }) {
  const normalizedLid = normalizeString(lId);
  if (!normalizedLid) return;

  const [rows] = await mysqlClient.execute(DB_QUERIES.LUDO_SELECT_JOIN_BY_LID_START, [normalizedLid]);
  if (!Array.isArray(rows) || rows.length === 0) return;

  const row = rows[0];
  const rowUserId = normalizeString(row.user_id);
  const rowContestId = normalizeString(row.contest_id || row.league_id);
  const rowStatus = normalizeString(row.status).toLowerCase();
  const reqUserId = normalizeString(userId);
  const reqContestId = normalizeString(contestId);

  // Allow reconnect/idempotent reconnect only for active lifecycle states.
  // Finalized states (expired/completed/cancelled) must use a new l_id.
  if (
    rowUserId === reqUserId &&
    rowContestId === reqContestId &&
    (rowStatus === 'pending' || rowStatus === 'matched' || rowStatus === 'active')
  ) {
    return;
  }

  throw new Error('Duplicate l_id detected or already finalized. Please use a new l_id.');
}


async function storeContestJoinSnapshot(userId, contestId, contestJoinData, clientLid = '') {
  const ttl = Number(process.env.CONTEST_JOIN_REDIS_TTL_SECONDS || 900);
  const picked = pickContestRecord(contestJoinData, contestId);
  const snapshot = buildContestSnapshot(userId, contestId, picked, clientLid);
  const key = buildContestJoinRedisKey(snapshot);
  await redis.set(key, snapshot, ttl);
  return snapshot;
}

function extractContestJoinPayload(apiData) {
  if (!apiData) return null;
  if (typeof apiData === 'object' && apiData.contest_join !== undefined) return apiData.contest_join;
  if (typeof apiData === 'object' && apiData.data !== undefined) return apiData.data;
  return apiData;
}

async function fetchContestJoinData(userId, contestId = '') {
  const baseUrl = (process.env.CONTEST_JOIN_API_BASE_URL || '').trim();
  const endpoint = (process.env.CONTEST_JOIN_API_ENDPOINT || '/contest-join/{userId}').trim();
  const method = (process.env.CONTEST_JOIN_API_METHOD || 'GET').toUpperCase();
  const timeout = Number(process.env.CONTEST_JOIN_API_TIMEOUT_MS || 5000);

  if (!baseUrl) {
    throw new Error('Contest join API is not configured');
  }

  const normalizedBaseUrl = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
  const normalizedEndpoint = endpoint.startsWith('/') ? endpoint : `/${endpoint}`;
  const withUserPath = normalizedEndpoint.includes('{userId}')
    ? normalizedEndpoint.replace('{userId}', encodeURIComponent(String(userId)))
    : normalizedEndpoint;
  const withContestPath = withUserPath.includes('{contestId}')
    ? withUserPath.replace('{contestId}', encodeURIComponent(String(contestId || '')))
    : withUserPath;
  const url = `${normalizedBaseUrl}${withContestPath}`;

  const headers = {};
  if (process.env.CONTEST_JOIN_API_BEARER_TOKEN) {
    headers.Authorization = `Bearer ${process.env.CONTEST_JOIN_API_BEARER_TOKEN}`;
  }
  if (process.env.CONTEST_JOIN_API_KEY) {
    headers['x-api-key'] = process.env.CONTEST_JOIN_API_KEY;
  }

  const reqConfig = { url, method, headers, timeout };
  if (method === 'GET') {
    reqConfig.params = { user_id: userId };
    if (contestId) reqConfig.params.contest_id = contestId;
  } else {
    reqConfig.data = { user_id: userId, contest_id: contestId || undefined };
  }

  try {
    const response = await axios(reqConfig);
    return extractContestJoinPayload(response.data);
  } catch (err) {
    const responseMessage = err.response?.data?.message || err.response?.data?.error;
    const message = responseMessage || err.message || 'Contest join API request failed';
    throw new Error(message);
  }
}

// ============================================================================
// Socket authentication middleware
// ============================================================================
async function socketAuthMiddleware(socket, next) {
  const socketId = socket.id;

  const userId =
    socket.handshake.auth?.user_id ||
    socket.handshake.query?.user_id;
  const contestId =
    socket.handshake.auth?.contest_id ||
    socket.handshake.query?.contest_id ||
    '';
  const clientLid =
    socket.handshake.auth?.l_id ||
    socket.handshake.query?.l_id ||
    '';

  const required = {
    user_id: normalizeString(userId),
    contest_id: normalizeString(contestId),
    l_id: normalizeString(clientLid)
  };

  if (!required.user_id || !required.contest_id || !required.l_id) {
    return next(new Error('Authentication error: user_id, contest_id and l_id are required'));
  }

  try {
    await validateLidUniquenessOrThrow({
      userId: required.user_id,
      contestId: required.contest_id,
      lId: required.l_id
    });

    const existingSession = await sessionService.getSessionOrThrow(required.user_id, { skipRedisRead: true });
    const contestJoinData = await fetchContestJoinData(required.user_id, required.contest_id);
    
    if (existingSession) {
      if (existingSession.socket_id && existingSession.socket_id !== socketId) {
        try {
          const existingSocket = socket.server.sockets.sockets.get(existingSession.socket_id);
          if (existingSocket) {
            existingSocket.disconnect(true);
          }
        } catch (error) {
        }
      }
    }
    
    const updated = await sessionService.updateSessionSocketIdForReconnect(required.user_id, socketId);
    if (!updated) {
      return next(new Error('Authentication error: Failed to update user session'));
    }
    
    await cleanupExistingSocketMappings(required.user_id, socketId);
    
    await storeSocketToUserMapping(socketId, required.user_id);
    await storeUserToSocketMapping(required.user_id, socketId);
    const contestJoinSnapshot = await storeContestJoinSnapshot(required.user_id, required.contest_id, contestJoinData, required.l_id);

    // Non-blocking background persistence to ludo_game as pending.
    setImmediate(() => {
      persistPendingJoinBackground(contestJoinSnapshot);
    });
    
    socket.user = {
      user_id: required.user_id,
      session_token: existingSession?.session_token || '',
      contest_join_data: contestJoinSnapshot
    };
    socket.contestJoinData = contestJoinSnapshot;
    
    next();
  } catch (err) {
    const message = err?.message || 'Invalid token';
    next(new Error(`Authentication error: ${message}`));
  }
}

// ============================================================================
// Clean up existing socket mappings for a user
// ============================================================================
async function cleanupExistingSocketMappings(userId, newSocketId) {
  try {
    const keys = await redis.keys(`${REDIS_KEYS.SOCKET_TO_USER('*')}`);
    const userSocketMappings = [];
    
    for (const key of keys) {
      const mappedUserId = await redis.get(key);
      if (normalizeString(mappedUserId) === normalizeString(userId)) {
        const socketId = key.replace('socket_to_user:', '');
        if (socketId !== newSocketId) {
          userSocketMappings.push(socketId);
        }
      }
    }
    
    for (const oldSocketId of userSocketMappings) {
      await redis.del(REDIS_KEYS.SOCKET_TO_USER(oldSocketId));
    }
  } catch (error) {
  }
}

// ============================================================================
// Store socket to user mapping in Redis for fast lookup
// ============================================================================
async function storeSocketToUserMapping(socketId, userId) {
  try {
    await redis.set(REDIS_KEYS.SOCKET_TO_USER(socketId), userId);
  } catch (error) {
    throw error;
  }
}

// ============================================================================
// Store user to socket mapping in Redis
// ============================================================================
async function storeUserToSocketMapping(userId, socketId) {
  try {
    const userKey = REDIS_KEYS.USER_TO_SOCKET(userId);
    const previousSocketId = normalizeString(await redis.get(userKey));
    if (previousSocketId && previousSocketId !== normalizeString(socketId)) {
      try {
        await redis.del(REDIS_KEYS.SOCKET_TO_USER(previousSocketId));
      } catch (_) {
      }
    }
    await redis.set(userKey, socketId);
  } catch (error) {
    throw error;
  }
}

module.exports = socketAuthMiddleware;
