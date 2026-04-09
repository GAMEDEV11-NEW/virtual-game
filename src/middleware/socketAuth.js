const { redis } = require('../utils/redis');
const mysqlClient = require('../services/mysql/client');
const { REDIS_KEYS, DB_QUERIES } = require('../constants');
const { config } = require('../utils/config');
const axios = require('axios');

function normalizeAuthToken(value) {
  const raw = normalizeString(value);
  if (!raw) return '';
  const match = raw.match(/^Bearer\s+(.+)$/i);
  return match ? normalizeString(match[1]) : raw;
}

function extractSocketJwtToken(socket) {
  return normalizeAuthToken(
    socket?.handshake?.auth?.jwt_token ||
    socket?.handshake?.query?.jwt_token ||
    socket?.handshake?.headers?.authorization ||
    socket?.handshake?.headers?.Authorization ||
    ''
  );
}

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
  const extraData = (record.extra_data && typeof record.extra_data === 'object') ? record.extra_data : {};
  const userProfile = (extraData.user && typeof extraData.user === 'object') ? extraData.user : {};
  const resolvedContestId = record.contest_id || record.league_id || contestId || '';
  const resolvedLid = normalizeString(clientLid) || record.l_id || record.id || '';
  return {
    user_id: String(userId),
    username: normalizeString(record.username || userProfile.username || ''),
    user_image: normalizeString(record.user_image || userProfile.image || ''),
    user_email: normalizeString(record.user_email || userProfile.email || ''),
    contest_id: String(resolvedContestId),
    league_id: record.league_id ? String(record.league_id) : '',
    l_id: resolvedLid,
    gameModeId: normalizeString(record.gameModeId || record.game_mode_id || ''),
    gameHistoryId: normalizeString(record.gameHistoryId || record.game_history_id || ''),
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

function firstNonEmpty(...values) {
  for (const value of values) {
    const normalized = normalizeString(value);
    if (normalized) return normalized;
  }
  return '';
}

function resolveMatchPairId(result = {}, session = {}) {
  return firstNonEmpty(
    result.matchPairId,
    session.matchPairId
  );
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
  const gameModeId = normalizeString(snapshot?.gameModeId || snapshot?.game_mode_id || '');
  const gameHistoryId = normalizeString(snapshot?.gameHistoryId || snapshot?.game_history_id || '');
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
      gameModeId || null,
      gameHistoryId || null,
      serverId
    ]);
  } catch (err) {
    void err;
    void joinedAtMysql;
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
  void key;
  return snapshot;
}

function buildNormalizedValidateUserPayload(apiData, fallback = {}) {
  if (!apiData || typeof apiData !== 'object') return null;

  // validate-user response contract:
  // { status: 1, result: { ..., session: {}, lobby: {}, game: {}, gameMode: {} } }
  if (Object.prototype.hasOwnProperty.call(apiData, 'status') && apiData.result && typeof apiData.result === 'object') {
    const statusCode = Number(apiData.status);
    const result = apiData.result || {};
    const message = normalizeString(apiData.message) || 'validate-user failed';

    if (statusCode !== 1) {
      throw new Error(message);
    }
    if (result.valid === false) {
      throw new Error('User validation failed');
    }
    if (result.blocked) {
      throw new Error('User is blocked');
    }
    if (result.joinDisabled) {
      throw new Error('Join is disabled');
    }

    const session = result.session && typeof result.session === 'object' ? result.session : {};
    const lobby = result.lobby && typeof result.lobby === 'object' ? result.lobby : {};
    const game = result.game && typeof result.game === 'object' ? result.game : {};
    const gameMode = result.gameMode && typeof result.gameMode === 'object' ? result.gameMode : {};
    const user = result.user && typeof result.user === 'object' ? result.user : {};
    const resolvedUsername = normalizeString(user.username || '');

    const gameId = firstNonEmpty(result.gameId, game.id, lobby.gameId);
    const contestId = normalizeString(session.lobbyId || lobby.id || fallback.contestId || '');
    const sessionId = normalizeString(session.sessionId || fallback.lId || '');
    const joinedAt = normalizeString(apiData.time_stamp || new Date().toISOString());
    const resolvedGameModeId = firstNonEmpty(
      result.gameModeId,
      lobby.gameModeId,
      gameMode.id
    );
    const resolvedGameHistoryId = firstNonEmpty(
      result.gameHistoryId,
      session.gameHistoryId,
      session.gameSessionDbId
    );
    const resolvedMatchPairId = resolveMatchPairId(result, session);
    const isLudo = gameId === '1';

    return {
      user_id: normalizeString(result.userId || fallback.userId || ''),
      username: resolvedUsername,
      user_image: normalizeString(user.image || ''),
      user_email: normalizeString(user.email || ''),
      contest_id: contestId,
      league_id: contestId,
      l_id: sessionId,
      game_type: isLudo ? 'ludo' : '',
      contest_type: isLudo ? 'simpleludo' : '',
      gameModeId: resolvedGameModeId,
      gameHistoryId: resolvedGameHistoryId,
      entry_fee: lobby.entryFee ?? null,
      joined_at: joinedAt,
      status: normalizeString(session.status || 'pending') || 'pending',
      status_id: '1',
      opponent_user_id: '',
      opponent_league_id: '',
      match_pair_id: resolvedMatchPairId || '',
      turn_id: '',
      extra_data: {
        valid: result.valid !== false,
        gameId: gameId || null,
        gameModeId: resolvedGameModeId || null,
        gameHistoryId: resolvedGameHistoryId || '',
        matchPairId: resolvedMatchPairId || '',
        activationStatus: normalizeString(result.activationStatus || ''),
        blocked: !!result.blocked,
        joinDisabled: !!result.joinDisabled,
        user,
        lobby,
        game,
        gameMode,
        session
      }
    };
  }

  return null;
}

function extractContestJoinPayload(apiData, fallback = {}) {
  const normalizedValidatePayload = buildNormalizedValidateUserPayload(apiData, fallback);
  if (normalizedValidatePayload) return normalizedValidatePayload;
  return null;
}

async function fetchContestJoinData(userId, contestId = '', jwtToken = '', lId = '') {
  const baseUrl = (process.env.CONTEST_JOIN_API_BASE_URL || '').trim();
  const endpoint = (process.env.CONTEST_JOIN_API_ENDPOINT || '').trim();
  const method = 'POST';
  const timeout = Number(process.env.CONTEST_JOIN_API_TIMEOUT_MS || 5000);
  const gameMatchKey = (process.env.CONTEST_JOIN_API_GAME_MATCH_KEY || '').trim();

  if (!baseUrl) {
    throw new Error('Contest join API is not configured');
  }
  if (!endpoint) {
    throw new Error('Contest join API endpoint is not configured');
  }
  if (!gameMatchKey) {
    throw new Error('Contest join API game match key is not configured');
  }

  const normalizedBaseUrl = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
  const normalizedEndpoint = endpoint.startsWith('/') ? endpoint : `/${endpoint}`;
  const url = `${normalizedBaseUrl}${normalizedEndpoint}`;

  const headers = {
    'Content-Type': 'application/json'
  };
  const authToken = normalizeAuthToken(jwtToken) || normalizeAuthToken(process.env.CONTEST_JOIN_API_BEARER_TOKEN);
  if (authToken) {
    headers.Authorization = `Bearer ${authToken}`;
  }
  headers['X-Game-Match-Key'] = gameMatchKey;

  const reqConfig = { url, method, headers, timeout };
  reqConfig.data = {
    userId: Number.isNaN(Number(userId)) ? String(userId) : Number(userId),
    sessionId: normalizeString(lId)
  };

  try {
    const response = await axios(reqConfig);
    const normalizedPayload = extractContestJoinPayload(response.data, { userId, contestId, lId });
    if (!normalizedPayload) {
      throw new Error('Invalid validate-user response format');
    }
    return normalizedPayload;
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
  const jwtToken = extractSocketJwtToken(socket);
 
  const required = {
    user_id: normalizeString(userId),
    contest_id: normalizeString(contestId),
    l_id: normalizeString(clientLid),
    jwt_token: normalizeString(jwtToken)
  };

  if (!required.user_id || !required.contest_id || !required.l_id || !required.jwt_token) {
    return next(new Error('Authentication error: user_id, contest_id, l_id and jwt_token are required'));
  }

  try {
    // 1) First check contest eligibility from API after basic required-field validation.
    const contestJoinData = await fetchContestJoinData(required.user_id, required.contest_id, required.jwt_token, required.l_id);

    // 2) Then validate l_id lifecycle/uniqueness.
    await validateLidUniquenessOrThrow({
      userId: required.user_id,
      contestId: required.contest_id,
      lId: required.l_id
    });

    // 3) Then continue socket mapping flow (session API dependency removed).
    await enforceSingleLidSocket(socket, required.l_id, socketId);
    await cleanupExistingSocketMappings(required.user_id, socketId);
    
    await storeSocketToUserMapping(socketId, required.user_id);
    await storeUserToSocketMapping(required.user_id, socketId);
    await storeLidSocketMappings(required.l_id, socketId);
    const contestJoinSnapshot = await storeContestJoinSnapshot(required.user_id, required.contest_id, contestJoinData, required.l_id);

    // Non-blocking background persistence to ludo_game as pending.
    setImmediate(() => {
      persistPendingJoinBackground(contestJoinSnapshot);
    });
    
    socket.user = {
      user_id: required.user_id,
      username: normalizeString(contestJoinSnapshot?.username || ''),
      user_image: normalizeString(contestJoinSnapshot?.user_image || ''),
      user_email: normalizeString(contestJoinSnapshot?.user_email || ''),
      contest_id: required.contest_id,
      l_id: required.l_id,
      jwt_token: required.jwt_token,
      session_token: '',
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
    const userKey = REDIS_KEYS.USER_TO_SOCKET(userId);
    const oldSocketId = normalizeString(await redis.get(userKey));
    const normalizedNewSocketId = normalizeString(newSocketId);
    if (oldSocketId && oldSocketId !== normalizedNewSocketId) {
      await redis.del(REDIS_KEYS.SOCKET_TO_USER(oldSocketId));
      await redis.del(REDIS_KEYS.SOCKET_TO_LID(oldSocketId));
    }
  } catch (error) {
  }
}

async function enforceSingleLidSocket(socket, lId, currentSocketId) {
  const normalizedLid = normalizeString(lId);
  const normalizedSocketId = normalizeString(currentSocketId);
  if (!normalizedLid || !normalizedSocketId) return;

  const lidKey = REDIS_KEYS.LID_TO_SOCKET(normalizedLid);
  const existingSocketId = normalizeString(await redis.get(lidKey));
  if (!existingSocketId || existingSocketId === normalizedSocketId) return;

  try {
    const existingSocket = socket.server.sockets.sockets.get(existingSocketId);
    if (existingSocket) {
      existingSocket.disconnect(true);
    }
  } catch (_) {
  }

  try {
    await redis.del(REDIS_KEYS.SOCKET_TO_USER(existingSocketId));
  } catch (_) {
  }
  try {
    await redis.del(REDIS_KEYS.SOCKET_TO_LID(existingSocketId));
  } catch (_) {
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

async function storeLidSocketMappings(lId, socketId) {
  const normalizedLid = normalizeString(lId);
  const normalizedSocketId = normalizeString(socketId);
  if (!normalizedLid || !normalizedSocketId) return;
  await redis.set(REDIS_KEYS.LID_TO_SOCKET(normalizedLid), normalizedSocketId);
  await redis.set(REDIS_KEYS.SOCKET_TO_LID(normalizedSocketId), normalizedLid);
}

module.exports = socketAuthMiddleware;
