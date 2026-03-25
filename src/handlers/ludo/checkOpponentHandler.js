const {
  validateJWTToken,
  validateJwtClaims,
  decryptUserData
} = require('../../utils/jwt');
const { authenticateOpponent } = require('../../utils/authUtils');
const {
  getLeagueJoinEntry,
  getUserPiecesCurrentState,
  enhancePiecesWithComprehensiveData,
  getDiceID,
  getUserById,
  getOpponentLeagueJoinStatus
} = require('../../services/ludo/gameService');
const sessionService = require('../../utils/sessionService');
const emitError = require('../../utils/emitError');
const validateFields = require('../../utils/validateFields');
const { parseJoinMonth } = require('../../utils/userUtils');
const { redis: redisClient } = require('../../utils/redis');
const { safeParseRedisData } = require('../../utils/gameUtils');
const { GAME_STATUS, REDIS_KEYS, DB_QUERIES } = require('../../constants');
const cassandraClient = require('../../services/cassandra/client');

// ============================================================================
// Handler constants
// ============================================================================

const REQUIRED_FIELDS = ['user_id', 'contest_id', 'l_id'];
const SNAKES_GAME_TYPES = new Set(['snakesladders', 'snakes_ladders', 'snake-ladder', 'snake_ladder']);
const WATER_SORT_GAME_TYPES = new Set(['water-sort-battle', 'watersort']);
const GAMES_WITH_PIECES = new Set(['ludo', ...SNAKES_GAME_TYPES]);
const COMPLETED_VALUE = (GAME_STATUS.COMPLETED || 'completed').toLowerCase();
const STATUS_ID_ACTIVE = '1';
const SELECT_MATCH_STATUS = 'SELECT status FROM match_pairs WHERE id = ?';
const SELECT_LEAGUE_JOIN_STATUS =
  'SELECT opponent_user_id, opponent_league_id, joined_at, match_pair_id, league_id, turn_id, id, status FROM league_joins WHERE user_id = ? AND status_id = ? AND join_month = ?';

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
// JWT validation
// ============================================================================
function validateJWTTokenAndClaims(jwtToken, socket) {
  if (!jwtToken) {
    emitError(socket, {
      code: 'missing_field',
      type: 'validation',
      field: 'jwt_token',
      message: 'JWT token is required',
      event: 'opponent:response'
    });
    return null;
  }

  const claims = validateJWTToken(jwtToken);
  if (!claims) {
    emitError(socket, {
      code: 'invalid_token',
      type: 'authentication',
      field: 'jwt_token',
      message: 'Invalid JWT token',
      event: 'opponent:response'
    });
    return null;
  }

  return validateJwtClaims(claims, socket, 'opponent:response');
}

// ============================================================================
// Session validation
// ============================================================================
async function validateUserSession(userID, socket) {
  const session = await sessionService.getSession(userID);
  if (!session) {
    emitError(socket, {
      code: 'session_not_found',
      type: 'authentication',
      field: 'user_id',
      message: 'User session not found',
      event: 'opponent:response'
    });
    return null;
  }
  return session;
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
          if (userID === match.user1_id) {
            userPieces = Array.isArray(match.user1_pieces) ? match.user1_pieces : [];
            opponentPieces = Array.isArray(match.user2_pieces) ? match.user2_pieces : [];
            userDiceID = match.user1_dice || null;
            opponentDiceID = match.user2_dice || null;
          } else if (userID === match.user2_id) {
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

  const userProfile = await getUserById(userID);
  const opponentProfile = opponentUserID === userID ? userProfile : await getUserById(opponentUserID);

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
  if (!Array.isArray(pieces) || pieces.length === 0) {
    let dbPieces = await getUserPiecesCurrentState(gameID, userID);
    if (!Array.isArray(dbPieces) || dbPieces.length === 0) {
      try {
        const { GamePiecesService } = require('../../cron/services/piecesService');
        const piecesService = new GamePiecesService(cassandraClient);
        await piecesService.createSnakesLaddersPiecesForMatch(gameID, userID, opponentUserID);
        dbPieces = await getUserPiecesCurrentState(gameID, userID);
      } catch (err) {
        logHandlerError('create snakes pieces failed', err, { gameID, userID });
      }
    }
    return enhancePiecesWithComprehensiveData(Array.isArray(dbPieces) ? dbPieces : [], gameID, userID);
  }
  return enhancePiecesWithComprehensiveData(pieces, gameID, userID);
}

// ============================================================================
// Ludo piece bootstrap
// ============================================================================
async function ensureLudoPieces(gameID, userID, pieces) {
  if (!Array.isArray(pieces) || pieces.length === 0) {
    const dbPieces = await getUserPiecesCurrentState(gameID, userID);
    return enhancePiecesWithComprehensiveData(Array.isArray(dbPieces) ? dbPieces : [], gameID, userID);
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

// ============================================================================
// Locate already-completed joins
// ============================================================================
async function findCompletedEntry({ userId, joinMonth, leagueJoinId }) {
  if (leagueJoinId) {
    try {
      const entryResult = await cassandraClient.execute(DB_QUERIES.SELECT_LEAGUE_JOIN_BY_ID, [leagueJoinId], { prepare: true });
      if (entryResult.rowLength > 0) {
        const entryRow = entryResult.rows[0];
        if (isCompletedStatus(entryRow.status)) {
          const sameUser = !userId || !entryRow.user_id || entryRow.user_id.toString() === userId.toString();
          if (sameUser) {
            return entryRow;
          }
        }
      }
    } catch (err) {
      logHandlerError('query league_joins_by_id failed', err, { leagueJoinId, userId });
    }
  }

  try {
    const result = await cassandraClient.execute(
      SELECT_LEAGUE_JOIN_STATUS,
      [userId, STATUS_ID_ACTIVE, joinMonth],
      { prepare: true }
    );

    return result.rows.find((row) => {
      if (!isCompletedStatus(row.status)) return false;
      if (!leagueJoinId) return true;
      return normalizeId(row.id).toLowerCase() === normalizeId(leagueJoinId).toLowerCase();
    });
  } catch (err) {
    logHandlerError('query league_joins failed', err, { userId, joinMonth });
  }

  return null;
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
async function checkMatchCompletion(entry, matchPairID, joinMonth) {
  if (!matchPairID) {
    return { completed: false };
  }

  try {
    const matchResult = await cassandraClient.execute(SELECT_MATCH_STATUS, [matchPairID], { prepare: true });
    if (matchResult.rowLength > 0) {
      const matchStatus = matchResult.first().status;
      if (isCompletedStatus(matchStatus)) {
        return { completed: true };
      }
    }
  } catch (err) {
    logHandlerError('check match_pairs status failed', err, { matchPairID });
  }

  const userCompleted = isCompletedStatus(entry.status);
  if (userCompleted) {
    return { completed: true };
  }

  if (!hasValidOpponent(entry)) {
    return { completed: false };
  }

  try {
    const opponentStatus = await getOpponentLeagueJoinStatus(entry.OpponentUserID, matchPairID, joinMonth);
    if (isCompletedStatus(opponentStatus)) {
      return { completed: true };
    }
  } catch (err) {
    logHandlerError('check opponent status failed', err, {
      opponentUserID: entry.OpponentUserID,
      matchPairID,
      joinMonth
    });
  }

  return { completed: false };
}

// ============================================================================
// Main handler
// ============================================================================
async function handleCheckOpponent(socket, data) {
  const decrypted = await authenticateOpponent(socket, data, 'opponent:response', decryptUserData);
  if (!decrypted) return;

  if (!validateFields(socket, decrypted, REQUIRED_FIELDS, 'opponent:response')) return;

  const { user_id, contest_id, l_id } = decrypted;
  const gameType = (decrypted.game_type || 'ludo').toString().toLowerCase();
  if (!validateJWTTokenAndClaims(decrypted.jwt_token, socket)) return;
  if (!(await validateUserSession(user_id, socket))) return;

  const joinMonthResult = parseJoinMonth(decrypted.joined_at, socket, 'opponent:response');
  if (joinMonthResult === null) return;

  const { joinMonth } = joinMonthResult;
  const entry = await getLeagueJoinEntry(user_id, contest_id, joinMonth, l_id);

  if (!entry) {
    const completedRow = await findCompletedEntry({ userId: user_id, joinMonth, leagueJoinId: l_id });
    if (completedRow) {
      socket.emit('opponent:response', {
        status: 'completed',
        user_id,
        opponent_user_id: '',
        opponent_league_id: completedRow.opponent_league_id ? completedRow.opponent_league_id.toString() : '',
        joined_at: completedRow.joined_at ? toIsoDate(completedRow.joined_at) : null,
        game_id: completedRow.match_pair_id ? completedRow.match_pair_id.toString() : '',
        user_pieces: [],
        opponent_pieces: [],
        pieces_status: 'completed',
        turn_id: completedRow.turn_id,
        message: 'Game has been completed'
      });
    } else {
      emitPendingOpponentResponse(socket, { UserID: user_id }, 'Waiting for opponent match...');
    }
    return;
  }

  if (!entry.UserID || !entry.MatchPairID) {
    emitPendingOpponentResponse(socket, entry, 'Entry data incomplete, waiting for match...');
    return;
  }

  const matchPairID = normalizeId(entry.MatchPairID);
  const completionState = await checkMatchCompletion(entry, matchPairID, joinMonth);
  if (completionState.completed) {
    socket.emit('opponent:response', {
      status: 'completed',
      user_id: entry.UserID ? String(entry.UserID) : '',
      opponent_user_id: entry.OpponentUserID ? String(entry.OpponentUserID) : '',
      opponent_league_id: entry.OpponentLeagueID ? String(entry.OpponentLeagueID) : '',
      joined_at: toIsoDate(entry.JoinedAt),
      game_id: matchPairID,
      user_pieces: [],
      opponent_pieces: [],
      pieces_status: 'completed',
      turn_id: entry.TurnID,
      message: 'Game has been completed'
    });
    return;
  }

  if (!hasValidOpponent(entry)) {
    emitPendingOpponentResponse(socket, entry);
    return;
  }

  const gameData = await fetchGamePiecesAndDice(matchPairID, entry.UserID, entry.OpponentUserID, gameType);

  if (WATER_SORT_GAME_TYPES.has(gameType)) {
    const waterSortPayload = await ensureWaterSortState(entry, gameData);
    socket.emit('opponent:response', waterSortPayload);
    return;
  }

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
