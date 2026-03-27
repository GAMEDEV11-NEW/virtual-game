const { authenticateOpponent } = require('../../utils/authUtils');
const {
  getLeagueJoinEntry,
  getLudoPiecesFromMatch,
  enhancePiecesWithComprehensiveData,
  getDiceID,
  getUserById,
  getOpponentLeagueJoinStatus
} = require('../../services/ludo/gameService');
const emitError = require('../../utils/emitError');
const validateFields = require('../../utils/validateFields');
const { redis: redisClient } = require('../../utils/redis');
const { safeParseRedisData } = require('../../utils/gameUtils');
const { GAME_STATUS, REDIS_KEYS, DB_QUERIES } = require('../../constants');
const mysqlClient = require('../../services/mysql/client');

// ============================================================================
// Handler constants
// ============================================================================

const REQUIRED_FIELDS = ['user_id', 'contest_id', 'l_id'];
const SNAKES_GAME_TYPES = new Set(['snakesladders', 'snakes_ladders', 'snake-ladder', 'snake_ladder']);
const WATER_SORT_GAME_TYPES = new Set(['water-sort-battle', 'watersort']);
const GAMES_WITH_PIECES = new Set(['ludo', ...SNAKES_GAME_TYPES]);
const COMPLETED_VALUE = (GAME_STATUS.COMPLETED || 'completed').toLowerCase();
const SELECT_MATCH_STATUS = DB_QUERIES.LUDO_SELECT_MATCH_STATUS;

// ============================================================================
// Logging helper
// ============================================================================
function logHandlerError(context, error, meta = {}) {
  return;
}

// ============================================================================
// Status helpers
// ============================================================================
function isCompletedStatus(status) {
  return (status || '').toLowerCase() === COMPLETED_VALUE;
}

function toIsoDate(value, fallback = new Date()) {
  if (!value) return fallback.toISOString();
  return value.toISOString ? value.toISOString() : new Date(value).toISOString();
}

function normalizeId(value) {
  if (value === null || value === undefined) return '';
  return value.toString().trim();
}

function hasValidOpponent(entry) {
  const opponentId = normalizeId(entry?.OpponentUserID).toLowerCase();
  if (!opponentId || opponentId === 'null' || opponentId === 'undefined') return false;
  return opponentId !== normalizeId(entry?.UserID).toLowerCase();
}

function sameNormalizedId(a, b) {
  return normalizeId(a) !== '' && normalizeId(a) === normalizeId(b);
}

async function getContestJoinSnapshotFromRedis(userId, contestId, lId) {
  const normalizedUserId = normalizeId(userId);
  const normalizedContestId = normalizeId(contestId);
  const normalizedLid = normalizeId(lId);
  if (!normalizedUserId || !normalizedContestId) return null;

  const keysToTry = [];
  if (normalizedLid) {
    keysToTry.push(`contest_join:${normalizedUserId}:${normalizedContestId}:${normalizedLid}`);
  }
  keysToTry.push(`contest_join:${normalizedUserId}:${normalizedContestId}`);
  keysToTry.push(`contest_join:${normalizedUserId}`);

  for (const key of keysToTry) {
    try {
      const value = await redisClient.get(key);
      const parsed = safeParseRedisData(value);
      if (parsed && typeof parsed === 'object') return parsed;
    } catch (_) {
    }
  }

  // Fallback pattern scan to support mixed/legacy keys.
  try {
    const patternKeys = await redisClient.scan(`contest_join:${normalizedUserId}:${normalizedContestId}:*`, { count: 50 });
    for (const key of patternKeys) {
      try {
        const value = await redisClient.get(key);
        const parsed = safeParseRedisData(value);
        if (parsed && typeof parsed === 'object') return parsed;
      } catch (_) {
      }
    }
  } catch (_) {
  }

  return null;
}

function mapContestJoinSnapshotToEntry(snapshot, fallback = {}) {
  if (!snapshot || typeof snapshot !== 'object') return null;
  return {
    UserID: snapshot.user_id || fallback.user_id || '',
    OpponentUserID: snapshot.opponent_user_id || '',
    OpponentLeagueID: snapshot.opponent_league_id || '',
    JoinedAt: snapshot.joined_at || null,
    MatchPairID: snapshot.match_id || snapshot.match_pair_id || '',
    TurnID: snapshot.turn_id || null,
    LeagueID: snapshot.league_id || fallback.contest_id || '',
    ID: snapshot.l_id || fallback.l_id || '',
    status: snapshot.status || 'pending'
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function hydrateEntryFromRedisMatch(entry, userId) {
  if (!entry) return entry;
  const matchPairID = normalizeId(entry.MatchPairID);
  if (!matchPairID) return entry;

  try {
    const matchRaw = await redisClient.get(REDIS_KEYS.MATCH(matchPairID));
    const match = safeParseRedisData(matchRaw);
    if (!match || typeof match !== 'object') return entry;

    const normalizedUserId = normalizeId(userId);
    const user1 = normalizeId(match.user1_id);
    const user2 = normalizeId(match.user2_id);

    if (!normalizeId(entry.OpponentUserID)) {
      if (normalizedUserId && normalizedUserId === user1) {
        entry.OpponentUserID = user2 || entry.OpponentUserID;
      } else if (normalizedUserId && normalizedUserId === user2) {
        entry.OpponentUserID = user1 || entry.OpponentUserID;
      }
    }

    if (!entry.TurnID && match.turn) {
      entry.TurnID = match.turn;
    }
  } catch (_) {
  }

  return entry;
}

async function getLeagueJoinEntryWithRetry(userId, contestId, lId, attempts = 3, waitMs = 120) {
  let latest = await getLeagueJoinEntry(userId, contestId, '', lId);
  for (let i = 1; i < attempts; i++) {
    if (latest && normalizeId(latest.MatchPairID) && hasValidOpponent(latest)) {
      return latest;
    }
    await sleep(waitMs);
    latest = await getLeagueJoinEntry(userId, contestId, '', lId);
  }
  return latest;
}


// ============================================================================
// Water sort state initialization
// ============================================================================
async function createInitialWaterSortState(gameId, user1Id, user2Id) {
  const now = new Date().toISOString();
  const { getWaterSortLevelMapData, getAvailableLevelNumbers } = require('../../services/watersort/levelCacheService');
  const availableLevels = await getAvailableLevelNumbers();
  const levelRanges = [
    [1, 50],
    [50, 100],
    [100, 200],
    [200, 300],
    [300, 400]
  ];

  const levels = [];
  let currentLevel = 1;

  for (let i = 0; i < levelRanges.length; i++) {
    const [min, max] = levelRanges[i];
    const levelsInRange = availableLevels.filter((level) => level >= min && level <= max);
    const levelNo = levelsInRange.length
      ? levelsInRange[Math.floor(Math.random() * levelsInRange.length)]
      : min + Math.floor(Math.random() * (max - min + 1));

    if (i === 0) currentLevel = levelNo;

    let levelMap = await getWaterSortLevelMapData(levelNo);
    if (!levelMap || levelMap.length === 0) {
      levelMap = [
        { values: [1, 2, 0, 1] },
        { values: [1, 1, 2, 2] },
        { values: [0, 0, 2, 1] },
        { values: [0, 1, 2, 0] }
      ];
    }

    levels.push({ no: levelNo, map: levelMap });
  }

  while (levels.length < 5) {
    levels.push({
      no: 1,
      map: [
        { values: [1, 2, 0, 1] },
        { values: [1, 1, 2, 2] },
        { values: [0, 0, 2, 1] },
        { values: [0, 1, 2, 0] }
      ]
    });
  }

  return {
    game_id: gameId,
    user1_id: user1Id,
    user2_id: user2Id,
    turn: user1Id,
    game_status: GAME_STATUS.ACTIVE,
    winner: '',
    user1_time: now,
    user2_time: now,
    start_time: now,
    last_move_time: now,
    puzzle_state: { levels },
    level_no: currentLevel,
    move_count: 0,
    move_sequence: [],
    user1_connection_count: 0,
    user2_connection_count: 0,
    user1_chance: 1,
    user2_chance: 1,
    game_type: 'watersort',
    contest_type: 'simple',
    user1_full_name: '',
    user1_profile_data: '',
    user2_full_name: '',
    user2_profile_data: '',
    user1_score: 0,
    user2_score: 0,
    user1_current_stage: 1,
    user2_current_stage: 1,
    user1_stages_completed: 0,
    user2_stages_completed: 0
  };
}

// ============================================================================
// Game pieces/dice retrieval
// ============================================================================
async function fetchGamePiecesAndDice(gameID, userID, opponentUserID, gameType = 'ludo') {
  const gameTypeLower = (gameType || '').toLowerCase();
  const needsPieces = GAMES_WITH_PIECES.has(gameTypeLower);
  const isSnakes = SNAKES_GAME_TYPES.has(gameTypeLower);

  let userPieces = [];
  let opponentPieces = [];
  let userDiceID = null;
  let opponentDiceID = null;
  let lastDiceRoll = null;
  let lastDiceUser = null;
  let lastDiceTime = null;

  if (needsPieces) {
    try {
      const matchKey = isSnakes ? REDIS_KEYS.SNAKES_MATCH(gameID) : REDIS_KEYS.MATCH(gameID);
      const matchData = await redisClient.get(matchKey);
      if (matchData) {
        const match = safeParseRedisData(matchData);
        if (match) {
          if (sameNormalizedId(userID, match.user1_id)) {
            userPieces = Array.isArray(match.user1_pieces) ? match.user1_pieces : [];
            opponentPieces = Array.isArray(match.user2_pieces) ? match.user2_pieces : [];
            userDiceID = match.user1_dice || null;
            opponentDiceID = match.user2_dice || null;
          } else if (sameNormalizedId(userID, match.user2_id)) {
            userPieces = Array.isArray(match.user2_pieces) ? match.user2_pieces : [];
            opponentPieces = Array.isArray(match.user1_pieces) ? match.user1_pieces : [];
            userDiceID = match.user2_dice || null;
            opponentDiceID = match.user1_dice || null;
          }

          if (isSnakes) {
            lastDiceRoll = match.last_dice_roll || null;
            lastDiceUser = match.last_dice_user || null;
            lastDiceTime = match.last_dice_time || null;
          }
        }
      }
    } catch (err) {
      logHandlerError('read match data failed', err, { gameID });
    }

    if (isSnakes) {
      userPieces = await ensureSnakesPieces(gameID, userID, userPieces, opponentUserID);
      opponentPieces = await ensureSnakesPieces(gameID, opponentUserID, opponentPieces, userID);
      userDiceID = await ensureDiceLookup(gameID, userID, userDiceID);
      opponentDiceID = await ensureDiceLookup(gameID, opponentUserID, opponentDiceID || (opponentUserID === userID ? userDiceID : null));
    } else {
      userPieces = await ensureLudoPieces(gameID, userID, userPieces);
      opponentPieces = opponentUserID === userID
        ? userPieces
        : await ensureLudoPieces(gameID, opponentUserID, opponentPieces);

      if (!opponentDiceID && opponentUserID) {
        opponentDiceID = await getDiceID(gameID, opponentUserID);
      }
      if (!userDiceID) {
        userDiceID = await getDiceID(gameID, userID);
      }
    }
  }

  // Profile fetch disabled for faster opponent polling response.
  // const userProfile = await getUserById(userID);
  // const opponentProfile = opponentUserID === userID ? userProfile : await getUserById(opponentUserID);
  const userProfile = null;
  const opponentProfile = null;

  return {
    userPieces: Array.isArray(userPieces) ? userPieces : [],
    opponentPieces: Array.isArray(opponentPieces) ? opponentPieces : [],
    userDiceID,
    opponentDiceID,
    userProfile,
    opponentProfile,
    lastDiceRoll,
    lastDiceUser,
    lastDiceTime
  };
}

// ============================================================================
// Snakes & Ladders piece bootstrap
// ============================================================================
async function ensureSnakesPieces(gameID, userID, pieces, opponentUserID) {
  return enhancePiecesWithComprehensiveData(Array.isArray(pieces) ? pieces : [], gameID, userID);
}

// ============================================================================
// Ludo piece bootstrap
// ============================================================================
async function ensureLudoPieces(gameID, userID, pieces) {
  if (!Array.isArray(pieces) || pieces.length === 0) {
    const fallbackPieces = await getLudoPiecesFromMatch(gameID, userID);
    return enhancePiecesWithComprehensiveData(Array.isArray(fallbackPieces) ? fallbackPieces : [], gameID, userID);
  }
  return enhancePiecesWithComprehensiveData(pieces, gameID, userID);
}

// ============================================================================
// Dice lookup helper
// ============================================================================
async function ensureDiceLookup(gameID, userID, diceId) {
  let result = diceId;
  if (!result) {
    result = await getDiceID(gameID, userID);
  }
  if (!result) {
    try {
      const { getOrCreateDiceLookupId } = require('../../helpers/ludo/diceRollHelpers');
      result = await getOrCreateDiceLookupId(gameID, userID);
    } catch (err) {
      logHandlerError('ensure dice lookup failed', err, { gameID, userID });
    }
  }
  return result || null;
}

// ============================================================================
// Emit success response with game data
// ============================================================================
function emitOpponentResponseWithGameData(socket, entry, gameData, gameType = 'ludo') {
  const gameTypeLower = (gameType || '').toLowerCase();
  const response = {
    status: 'success',
    user_id: entry.UserID ? String(entry.UserID) : '',
    opponent_user_id: entry.OpponentUserID ? String(entry.OpponentUserID) : '',
    opponent_league_id: entry.OpponentLeagueID ? String(entry.OpponentLeagueID) : '',
    joined_at: toIsoDate(entry.JoinedAt),
    game_id: normalizeId(entry.MatchPairID),
    user_pieces: Array.isArray(gameData.userPieces) ? gameData.userPieces : [],
    opponent_pieces: Array.isArray(gameData.opponentPieces) ? gameData.opponentPieces : [],
    user_dice: gameData.userDiceID ?? null,
    opponent_dice: gameData.opponentDiceID ?? null,
    pieces_status: 'active',
    turn_id: entry.TurnID ?? null,
    start_time: toIsoDate(entry.JoinedAt),
    user_full_name: gameData.userProfile?.full_name ?? '',
    user_profile_data: gameData.userProfile?.profile_data ?? '',
    opponent_full_name: gameData.opponentProfile?.full_name ?? '',
    opponent_profile_data: gameData.opponentProfile?.profile_data ?? ''
  };

  if (SNAKES_GAME_TYPES.has(gameTypeLower)) {
    response.last_dice_roll = gameData.lastDiceRoll || null;
    response.last_dice_user = gameData.lastDiceUser || null;
    response.last_dice_time = gameData.lastDiceTime || null;
  }

  socket.emit('opponent:response', response);
}

// ============================================================================
// Emit pending response
// ============================================================================
function emitPendingOpponentResponse(socket, entry = {}, message = 'Waiting for opponent match...') {
  socket.emit('opponent:response', {
    status: 'pending',
    user_id: entry.UserID ? String(entry.UserID) : '',
    opponent_user_id: '',
    opponent_league_id: '',
    joined_at: entry.JoinedAt ? toIsoDate(entry.JoinedAt) : null,
    game_id: '',
    user_pieces: [],
    opponent_pieces: [],
    pieces_status: 'pending',
    turn_id: entry.TurnID ?? null,
    message
  });
}

function emitCompletedOpponentResponse(socket, payload = {}) {
  socket.emit('opponent:response', {
    status: 'completed',
    user_id: payload.user_id ? String(payload.user_id) : '',
    opponent_user_id: payload.opponent_user_id ? String(payload.opponent_user_id) : '',
    opponent_league_id: payload.opponent_league_id ? String(payload.opponent_league_id) : '',
    joined_at: payload.joined_at || null,
    game_id: payload.game_id ? String(payload.game_id) : '',
    user_pieces: [],
    opponent_pieces: [],
    pieces_status: 'completed',
    turn_id: payload.turn_id ?? null,
    message: 'Game has been completed'
  });
}

function emitExpiredAndDisconnect(socket, payload = {}) {
  socket.emit('opponent:response', {
    status: 'expired',
    user_id: payload.user_id ? String(payload.user_id) : '',
    opponent_user_id: '',
    opponent_league_id: '',
    joined_at: payload.joined_at || null,
    game_id: '',
    user_pieces: [],
    opponent_pieces: [],
    pieces_status: 'expired',
    turn_id: null,
    message: 'Entry expired'
  });

  setTimeout(() => {
    try {
      socket.disconnect(true);
    } catch (_) {
    }
  }, 50);
}

async function cleanupExpiredContestJoinCache(userId, contestId, lId) {
  const normalizedUserId = normalizeId(userId);
  const normalizedContestId = normalizeId(contestId);
  const normalizedLid = normalizeId(lId);
  if (!normalizedUserId || !normalizedContestId) return;

  const keys = [];
  if (normalizedLid) {
    keys.push(`contest_join:${normalizedUserId}:${normalizedContestId}:${normalizedLid}`);
  }
  keys.push(`contest_join:${normalizedUserId}:${normalizedContestId}`);
  keys.push(`contest_join:${normalizedUserId}`);

  for (const key of keys) {
    try {
      await redisClient.del(key);
    } catch (_) {
    }
  }

  try {
    const patternKeys = await redisClient.scan(`contest_join:${normalizedUserId}:${normalizedContestId}:*`, { count: 200 });
    for (const key of patternKeys) {
      try {
        await redisClient.del(key);
      } catch (_) {
      }
    }
  } catch (_) {
  }
}

// ============================================================================
// Locate already-completed joins
// ============================================================================
async function findCompletedEntry({ userId, leagueJoinId }) {
  if (leagueJoinId) {
    try {
      const [rows] = await mysqlClient.execute(DB_QUERIES.LUDO_SELECT_COMPLETED_BY_LID, [leagueJoinId]);
      if (Array.isArray(rows) && rows.length > 0) {
        const entryRow = rows[0];
        if (isCompletedStatus(entryRow.status)) {
          const sameUser = !userId || !entryRow.user_id || entryRow.user_id.toString() === userId.toString();
          if (sameUser) {
            return entryRow;
          }
        }
      }
    } catch (err) {
      logHandlerError('query ludo_game by l_id failed', err, { leagueJoinId, userId });
    }
  }

  try {
    const [rows] = await mysqlClient.execute(DB_QUERIES.LUDO_SELECT_COMPLETED_BY_USER, [userId]);
    if (!Array.isArray(rows) || rows.length === 0) return null;
    return rows.find((row) => {
      if (!isCompletedStatus(row.status)) return false;
      if (!leagueJoinId) return true;
      return normalizeId(row.l_id).toLowerCase() === normalizeId(leagueJoinId).toLowerCase();
    }) || null;
  } catch (err) {
    logHandlerError('query ludo_game by user failed', err, { userId });
  }

  return null;
}

async function findExpiredEntry({ userId, leagueJoinId }) {
  if (leagueJoinId) {
    try {
      const [rows] = await mysqlClient.execute(
        `
          SELECT l_id, user_id, joined_at, status, is_deleted
          FROM ludo_game
          WHERE l_id = ? AND status = 'expired'
          ORDER BY updated_at DESC
          LIMIT 1
        `,
        [leagueJoinId]
      );
      if (Array.isArray(rows) && rows.length > 0) return rows[0];
    } catch (err) {
      logHandlerError('query expired by l_id failed', err, { leagueJoinId, userId });
    }
  }

  try {
    const [rows] = await mysqlClient.execute(
      `
        SELECT l_id, user_id, joined_at, status, is_deleted
        FROM ludo_game
        WHERE user_id = ? AND status = 'expired'
        ORDER BY updated_at DESC
        LIMIT 1
      `,
      [userId]
    );
    if (!Array.isArray(rows) || rows.length === 0) return null;
    return rows[0];
  } catch (err) {
    logHandlerError('query expired by user failed', err, { userId });
    return null;
  }
}

// ============================================================================
// Ensure water sort payload exists
// ============================================================================
async function ensureWaterSortState(entry, gameData) {
  const matchId = normalizeId(entry.MatchPairID);
  const wsKey = REDIS_KEYS.WATERSORT_MATCH(matchId);
  let wsState = await redisClient.get(wsKey);
  wsState = safeParseRedisData(wsState);

  if (!wsState) {
    wsState = await createInitialWaterSortState(matchId, entry.UserID, entry.OpponentUserID);
    await redisClient.set(wsKey, JSON.stringify(wsState));
  }

  if (!wsState.puzzle_state || !Array.isArray(wsState.puzzle_state.levels) || wsState.puzzle_state.levels.length !== 5) {
    const { getWaterSortLevelMapData, getAvailableLevelNumbers } = require('../../services/watersort/levelCacheService');
    const availableLevels = await getAvailableLevelNumbers();
    const levelRanges = [[1, 50], [50, 100], [100, 200], [200, 300], [300, 400]];
    const levels = [];
    let currentLevel = 1;
    const matchIdHash = matchId.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0);

    for (let i = 0; i < levelRanges.length; i++) {
      const [min, max] = levelRanges[i];
      const levelsInRange = availableLevels.filter((level) => level >= min && level <= max);
      let levelNo;
      if (levelsInRange.length > 0) {
        const seed = (matchIdHash + i) % levelsInRange.length;
        levelNo = levelsInRange[seed];
      } else {
        const seed = (matchIdHash + i) % (max - min + 1);
        levelNo = min + seed;
      }

      if (i === 0) currentLevel = levelNo;

      let levelMap = await getWaterSortLevelMapData(levelNo);
      if (!levelMap || levelMap.length === 0) {
        levelMap = [
          { values: [1, 2, 0, 1] },
          { values: [1, 1, 2, 2] },
          { values: [0, 0, 2, 1] },
          { values: [0, 1, 2, 0] }
        ];
      }

      levels.push({ no: levelNo, map: levelMap });
    }

    wsState.puzzle_state = { levels };
    wsState.level_no = currentLevel;
    await redisClient.set(wsKey, JSON.stringify(wsState));
  }

  const userPieces = Array.isArray(gameData.userPieces) ? gameData.userPieces : [];
  const opponentPieces = Array.isArray(gameData.opponentPieces) ? gameData.opponentPieces : [];

  return {
    status: 'success',
    user_id: entry.UserID,
    opponent_user_id: entry.OpponentUserID,
    opponent_league_id: entry.OpponentLeagueID,
    joined_at: toIsoDate(entry.JoinedAt),
    game_id: matchId,
    user_pieces: userPieces,
    opponent_pieces: opponentPieces,
    user_dice: gameData.userDiceID ?? null,
    opponent_dice: gameData.opponentDiceID ?? null,
    pieces_status: 'active',
    turn_id: entry.TurnID,
    start_time: new Date().toISOString(),
    user_full_name: gameData.userProfile?.full_name ?? '',
    user_profile_data: gameData.userProfile?.profile_data ?? '',
    opponent_full_name: gameData.opponentProfile?.full_name ?? '',
    opponent_profile_data: gameData.opponentProfile?.profile_data ?? '',
    game_type: 'water-sort-battle',
    puzzle_state: wsState.puzzle_state
  };
}

// ============================================================================
// Determine if match or league joins are completed
// ============================================================================
async function checkMatchCompletion(entry, matchPairID) {
  if (!matchPairID) {
    return { completed: false };
  }

  try {
    const [rows] = await mysqlClient.execute(SELECT_MATCH_STATUS, [matchPairID]);
    if (Array.isArray(rows) && rows.length > 0) {
      const matchStatus = rows[0]?.status;
      if (isCompletedStatus(matchStatus)) {
        return { completed: true };
      }
    }
  } catch (err) {
    logHandlerError('check ludo_game match status failed', err, { matchPairID });
  }

  const userCompleted = isCompletedStatus(entry.status);
  if (userCompleted) {
    return { completed: true };
  }

  if (!hasValidOpponent(entry)) {
    return { completed: false };
  }

  try {
    const opponentStatus = await getOpponentLeagueJoinStatus(entry.OpponentUserID, matchPairID);
    if (isCompletedStatus(opponentStatus)) {
      return { completed: true };
    }
  } catch (err) {
    logHandlerError('check opponent status failed', err, {
      opponentUserID: entry.OpponentUserID,
      matchPairID
    });
  }

  return { completed: false };
}

// ============================================================================
// Main handler
// ============================================================================
async function handleCheckOpponent(socket, data) {
  const payload = await authenticateOpponent(socket, data, 'opponent:response');
  if (!payload) {
    return;
  }
  if (!validateFields(socket, payload, REQUIRED_FIELDS, 'opponent:response')) {
    return;
  }

  const { user_id, contest_id, l_id } = payload;
  const gameType = (payload.game_type || 'ludo').toString().toLowerCase();

  // Redis-first fast path to reduce DB load for repeated polling.
  const contestSnapshot = await getContestJoinSnapshotFromRedis(user_id, contest_id, l_id);
  let entry = mapContestJoinSnapshotToEntry(contestSnapshot, { user_id, contest_id, l_id });
  entry = await hydrateEntryFromRedisMatch(entry, user_id);

  if (!(entry && normalizeId(entry.MatchPairID) && hasValidOpponent(entry))) {
    // DB fallback when redis snapshot is missing/incomplete.
    entry = await getLeagueJoinEntryWithRetry(user_id, contest_id, l_id);
  }

  if (!entry) {
    const completedRow = await findCompletedEntry({ userId: user_id, leagueJoinId: l_id });
    if (completedRow) {
      emitCompletedOpponentResponse(socket, {
        user_id,
        opponent_user_id: completedRow.opponent_user_id || '',
        opponent_league_id: completedRow.opponent_league_id ? completedRow.opponent_league_id.toString() : '',
        joined_at: completedRow.joined_at ? toIsoDate(completedRow.joined_at) : null,
        game_id: completedRow.match_id ? completedRow.match_id.toString() : '',
        turn_id: completedRow.turn_id
      });
      return;
    }

    const expiredRow = await findExpiredEntry({ userId: user_id, leagueJoinId: l_id });
    if (expiredRow) {
      await cleanupExpiredContestJoinCache(user_id, contest_id, l_id || expiredRow.l_id);
      emitExpiredAndDisconnect(socket, {
        user_id,
        joined_at: expiredRow.joined_at ? toIsoDate(expiredRow.joined_at) : null
      });
      return;
    }

    emitPendingOpponentResponse(socket, { UserID: user_id }, 'Waiting for opponent match...');
    return;
  }

  entry = await hydrateEntryFromRedisMatch(entry, user_id);

  const normalizedMatchPairId = normalizeId(entry.MatchPairID);
  if (!entry.UserID || !normalizedMatchPairId) {
    const statusLower = normalizeId(entry.status).toLowerCase();
    const waitMessage = statusLower === 'matched'
      ? 'Matched found, preparing game...'
      : 'Entry data incomplete, waiting for match...';
    emitPendingOpponentResponse(socket, entry, waitMessage);
    return;
  }

  const matchPairID = normalizedMatchPairId;
  const completionState = await checkMatchCompletion(entry, matchPairID);
  if (completionState.completed) {
    emitCompletedOpponentResponse(socket, {
      user_id: entry.UserID ? String(entry.UserID) : '',
      opponent_user_id: entry.OpponentUserID ? String(entry.OpponentUserID) : '',
      opponent_league_id: entry.OpponentLeagueID ? String(entry.OpponentLeagueID) : '',
      joined_at: toIsoDate(entry.JoinedAt),
      game_id: matchPairID,
      turn_id: entry.TurnID
    });
    return;
  }

  if (!hasValidOpponent(entry)) {
    emitPendingOpponentResponse(socket, entry);
    return;
  }

  const gameData = await fetchGamePiecesAndDice(matchPairID, entry.UserID, entry.OpponentUserID, gameType);

  // if (WATER_SORT_GAME_TYPES.has(gameType)) {
  //   console.error('[check:opponent] watersort_payload_emit', { user_id: entry.UserID, matchPairID });
  //   const waterSortPayload = await ensureWaterSortState(entry, gameData);
  //   socket.emit('opponent:response', waterSortPayload);
  //   return;
  // }

  emitOpponentResponseWithGameData(socket, entry, gameData, gameType);
}

// ============================================================================
// Socket.io registration
// ============================================================================
function registerCheckOpponentHandler(io, socket) {
  socket.removeAllListeners('check:opponent');
  socket.on('check:opponent', async (request) => {
    await handleCheckOpponent(socket, request);
  });
}

module.exports = { registerCheckOpponentHandler };
