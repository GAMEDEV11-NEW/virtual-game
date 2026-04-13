const withAuth = require('../../middleware/withAuth');
const { redis: redisClient } = require('../../utils/redis');
const mysqlClient = require('../../services/mysql/client');
const { validateRequiredFields, emitStandardError, safeParseRedisData } = require('../../utils/gameUtils');
const { GAME_CONFIG } = require('../../config/gameConfig');
const { REDIS_KEYS } = require('../../constants');

const EVENTS = {
  REQUEST: 'get:match_state',
  RESPONSE: 'get:match_state:response'
};

function normalizeId(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

function sameId(a, b) {
  const na = normalizeId(a);
  const nb = normalizeId(b);
  if (!na || !nb) return false;
  return na === nb;
}

function safeParseObject(value) {
  if (!value) return null;
  if (typeof value === 'object') return value;
  if (typeof value !== 'string') return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch (_) {
    return null;
  }
}

function stringifyProfile(profile = {}) {
  const username = normalizeId(profile.username || '');
  const image = normalizeId(profile.image || '');
  const email = normalizeId(profile.email || '');
  if (!username && !image && !email) return '';
  return JSON.stringify({ username, image, email });
}

async function getParsedRedisObject(key) {
  try {
    const value = await redisClient.get(key);
    const parsed = safeParseRedisData(value);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch (_) {
    return null;
  }
}

async function getContestJoinSnapshotFromRedis(userId, contestId, lId) {
  const uid = normalizeId(userId);
  const cid = normalizeId(contestId);
  const lid = normalizeId(lId);
  if (!uid || !cid) return null;

  const keys = [];
  if (lid) keys.push(`contest_join:${uid}:${cid}:${lid}`);
  keys.push(`contest_join:${uid}:${cid}`);
  keys.push(`contest_join:${uid}`);

  for (const key of keys) {
    const parsed = await getParsedRedisObject(key);
    if (parsed) return parsed;
  }

  try {
    const scanned = await redisClient.scan(`contest_join:${uid}:${cid}:*`, { count: 50 });
    for (const key of scanned) {
      const parsed = await getParsedRedisObject(key);
      if (parsed) return parsed;
    }
  } catch (_) {
  }

  return null;
}

async function getMatchStateFromDb(gameId, userId) {
  const gid = normalizeId(gameId);
  const uid = normalizeId(userId);
  if (!gid || !uid) return null;

  try {
    const [rows] = await mysqlClient.execute(
      `
        SELECT
          match_id,
          user_id,
          opponent_user_id,
          status,
          turn_id,
          winner_user_id,
          contest_type,
          started_at,
          updated_at,
          ended_at,
          last_move_at
        FROM ludo_game
        WHERE match_id = ? AND is_deleted = 0 AND (user_id = ? OR opponent_user_id = ?)
        ORDER BY CASE WHEN user_id = ? THEN 0 ELSE 1 END, updated_at DESC
        LIMIT 1
      `,
      [gid, uid, uid, uid]
    );
    if (!Array.isArray(rows) || rows.length === 0) return null;

    const row = rows[0];
    return {
      game_id: normalizeId(row.match_id || gid),
      user1_id: normalizeId(row.user_id || ''),
      user2_id: normalizeId(row.opponent_user_id || ''),
      turn: normalizeId(row.turn_id || ''),
      status: normalizeId(row.status || 'active') || 'active',
      winner: normalizeId(row.winner_user_id || ''),
      contest_type: normalizeId(row.contest_type || ''),
      game_type: 'ludo',
      user1_pieces: [],
      user2_pieces: [],
      user1_score: 0,
      user2_score: 0,
      user1_chance: 0,
      user2_chance: 0,
      user1_time: null,
      user2_time: null,
      start_time: row.started_at || null,
      updated_at: row.updated_at || row.last_move_at || row.ended_at || null
    };
  } catch (_) {
    return null;
  }
}

function profileFromSnapshot(snapshot = null) {
  if (!snapshot || typeof snapshot !== 'object') return { username: '', image: '', email: '' };
  const extraData = safeParseObject(snapshot.extra_data) || {};
  const user = (extraData.user && typeof extraData.user === 'object') ? extraData.user : {};
  return {
    username: normalizeId(snapshot.username || user.username || ''),
    image: normalizeId(snapshot.user_image || user.image || ''),
    email: normalizeId(snapshot.user_email || user.email || '')
  };
}

function profileFromMatch(match, targetUserId) {
  const uid = normalizeId(targetUserId);
  if (!uid || !match) return { username: '', image: '', email: '' };
  const isUser1 = sameId(uid, match.user1_id);
  const profileRaw = isUser1 ? match.user1_profile : match.user2_profile;
  const profile = safeParseObject(profileRaw) || (profileRaw && typeof profileRaw === 'object' ? profileRaw : {});
  const usernameFallback = isUser1 ? match.user1_username : match.user2_username;
  return {
    username: normalizeId(profile.username || usernameFallback || ''),
    image: normalizeId(profile.image || ''),
    email: normalizeId(profile.email || '')
  };
}

function toDateSafe(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function remainingSecondsFrom(lastTimeIso, timeoutSeconds) {
  const lastTime = toDateSafe(lastTimeIso);
  if (!lastTime) return timeoutSeconds;
  const elapsed = Math.floor((Date.now() - lastTime.getTime()) / 1000);
  return Math.max(0, timeoutSeconds - elapsed);
}

function buildTimeLeftData(match) {
  const timeoutSeconds = Number(GAME_CONFIG?.TIMING?.ALLOWED_TURN_DELAY_SECONDS || 15);
  const user1Left = remainingSecondsFrom(match?.user1_time, timeoutSeconds);
  const user2Left = remainingSecondsFrom(match?.user2_time, timeoutSeconds);
  return {
    user1_time_left_seconds: user1Left,
    user2_time_left_seconds: user2Left
  };
}

function buildMatchStateResponse(match, userId, selfProfile = {}, opponentProfile = {}) {
  const timeLeft = buildTimeLeftData(match);
  return {
    status: 'success',
    game_id: normalizeId(match?.game_id || ''),
    user_id: normalizeId(userId),
    user_full_name: normalizeId(selfProfile.username || ''),
    user_profile_data: stringifyProfile(selfProfile),
    opponent_full_name: normalizeId(opponentProfile.username || ''),
    opponent_profile_data: stringifyProfile(opponentProfile),
    user_username: normalizeId(selfProfile.username || ''),
    opponent_username: normalizeId(opponentProfile.username || ''),
    match_state: {
      game_id: normalizeId(match?.game_id || ''),
      user1_id: normalizeId(match?.user1_id || ''),
      user2_id: normalizeId(match?.user2_id || ''),
      turn: normalizeId(match?.turn || ''),
      status: match?.status || 'active',
      winner: normalizeId(match?.winner || ''),
      contest_type: match?.contest_type || '',
      game_type: match?.game_type || 'ludo',
      user1_pieces: Array.isArray(match?.user1_pieces) ? match.user1_pieces : [],
      user2_pieces: Array.isArray(match?.user2_pieces) ? match.user2_pieces : [],
      user1_score: match?.user1_score ?? 0,
      user2_score: match?.user2_score ?? 0,
      user1_chance: match?.user1_chance ?? 0,
      user2_chance: match?.user2_chance ?? 0,
      user1_time: match?.user1_time || null,
      user2_time: match?.user2_time || null,
      user1_time_left_seconds: timeLeft.user1_time_left_seconds,
      user2_time_left_seconds: timeLeft.user2_time_left_seconds,
      start_time: match?.start_time || null,
      updated_at: match?.updated_at || null
    },
    timestamp: new Date().toISOString()
  };
}

function buildPendingMatchStateResponse(userId, contestId, lId, selfProfile = {}) {
  return {
    status: 'pending',
    game_id: '',
    user_id: normalizeId(userId),
    contest_id: normalizeId(contestId),
    l_id: normalizeId(lId),
    user_full_name: normalizeId(selfProfile.username || ''),
    user_profile_data: stringifyProfile(selfProfile),
    user_username: normalizeId(selfProfile.username || ''),
    match_state: null,
    message: 'Waiting for match...',
    timestamp: new Date().toISOString()
  };
}

function registerMatchStateHandler(io, socket) {
  socket.removeAllListeners(EVENTS.REQUEST);
  socket.on(EVENTS.REQUEST, async (event) => {
    try {
      await withAuth(socket, event, EVENTS.RESPONSE, async (user, data) => {
        const payload = (data && typeof data === 'object') ? data : {};
        if (!validateRequiredFields(socket, payload, ['contest_id', 'l_id', 'user_id'], EVENTS.RESPONSE)) {
          return;
        }

        const requiredStringFields = ['contest_id', 'l_id', 'user_id'];
        const invalidField = requiredStringFields.find((field) => !normalizeId(payload[field]));
        if (invalidField) {
          emitStandardError(socket, {
            code: 'invalid_value',
            type: 'validation',
            field: invalidField,
            message: `${invalidField} is required and must be non-empty`
          }, EVENTS.RESPONSE);
          return;
        }

        const userId = normalizeId(payload.user_id);
        const contestId = normalizeId(payload.contest_id);
        const lId = normalizeId(payload.l_id);
        const authUserId = normalizeId(user?.user_id || socket?.user?.user_id || '');
        if (authUserId && userId !== authUserId) {
          emitStandardError(socket, {
            code: 'auth_failed',
            type: 'authentication',
            field: 'user_id',
            message: 'Request user_id does not match authenticated user'
          }, EVENTS.RESPONSE);
          return;
        }

        const gameId = normalizeId(payload.game_id);
        const selfSnapshot = await getContestJoinSnapshotFromRedis(userId, contestId, lId);
        const selfProfile = profileFromSnapshot(selfSnapshot);
        if (!gameId) {
          socket.emit(EVENTS.RESPONSE, buildPendingMatchStateResponse(userId, contestId, lId, selfProfile));
          return;
        }

        const matchRaw = await redisClient.get(REDIS_KEYS.MATCH(gameId));
        let match = safeParseRedisData(matchRaw);
        if (!match || typeof match !== 'object') {
          match = await getMatchStateFromDb(gameId, userId);
        }
        if (!match) {
          socket.emit(EVENTS.RESPONSE, buildPendingMatchStateResponse(userId, contestId, lId, selfProfile));
          return;
        }

        if (!sameId(userId, match.user1_id) && !sameId(userId, match.user2_id)) {
          emitStandardError(socket, {
            code: 'invalid_user',
            type: 'data',
            field: 'user_id',
            message: 'User not part of this match'
          }, EVENTS.RESPONSE);
          return;
        }

        const opponentUserId = sameId(userId, match.user1_id) ? normalizeId(match.user2_id) : normalizeId(match.user1_id);
        const opponentSnapshot = await getContestJoinSnapshotFromRedis(opponentUserId, contestId, '');
        const opponentProfileFromSnapshot = profileFromSnapshot(opponentSnapshot);
        const selfProfileFromMatch = profileFromMatch(match, userId);
        const opponentProfileFromMatch = profileFromMatch(match, opponentUserId);
        const resolvedSelfProfile = {
          username: normalizeId(selfProfile.username || selfProfileFromMatch.username || ''),
          image: normalizeId(selfProfile.image || selfProfileFromMatch.image || ''),
          email: normalizeId(selfProfile.email || selfProfileFromMatch.email || '')
        };
        const resolvedOpponentProfile = {
          username: normalizeId(opponentProfileFromSnapshot.username || opponentProfileFromMatch.username || ''),
          image: normalizeId(opponentProfileFromSnapshot.image || opponentProfileFromMatch.image || ''),
          email: normalizeId(opponentProfileFromSnapshot.email || opponentProfileFromMatch.email || '')
        };

        socket.emit(EVENTS.RESPONSE, buildMatchStateResponse(match, userId, resolvedSelfProfile, resolvedOpponentProfile));
      });
    } catch (err) {
      emitStandardError(socket, {
        code: 'handler_error',
        type: 'system',
        field: 'handler',
        message: err?.message || 'Failed to fetch match state'
      }, EVENTS.RESPONSE);
    }
  });
}

module.exports = { registerMatchStateHandler };
