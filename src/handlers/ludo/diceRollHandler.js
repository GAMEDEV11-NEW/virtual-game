const { processDiceRoll, broadcastDiceRollToOpponent } = require('../../helpers/ludo/diceRollHelpers');
const { findActiveOpponentSocketId } = require('../../helpers/common/gameHelpers');
const { redis: redisClient } = require('../../utils/redis');
const { getUserPiecesCurrentState } = require('../../services/ludo/gameService');
const { fetchMatchOrEmitError, validateRequiredFields, emitStandardError, saveMatchState, saveMatchFields, safeParseRedisData } = require('../../utils/gameUtils');
const { createResponseGuarantee } = require('../../utils/responseGuarantee');
const withAuth = require('../../middleware/withAuth');
const { GAME_CONFIG } = require('../../config/gameConfig');
const { scoreDiceRoll } = require('../../services/ludo/scoreService');
const { REDIS_KEYS, GAME_STATUS } = require('../../constants');

// ============================================================================
// isNonEmptyString
// ============================================================================
function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function normalizeIdValue(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

function sameId(a, b) {
  const na = normalizeIdValue(a);
  const nb = normalizeIdValue(b);
  if (!na || !nb) return false;
  return na === nb;
}

// ============================================================================
// logDiceHandlerError
// ============================================================================
function logDiceHandlerError(context, error, metadata = {}) {
  if (process.env.DICE_HANDLER_DEBUG === 'true') {
    console.error('[dice:roll]', context, {
      message: error?.message || String(error || ''),
      ...metadata
    });
  }
}

// ============================================================================
// normalizePiecePosition
// ============================================================================
function normalizePiecePosition(position) {
  if (position === null || position === undefined || position === 'initial' || position === 'goal' || position === 'finished') {
    return null;
  }

  if (typeof position === 'string') {
    const num = parseInt(position, 10);
    if (!isNaN(num)) {
      return num;
    }
  }

  if (typeof position === 'number' && !isNaN(position)) {
    return position;
  }

  return null;
}

// ============================================================================
// canPieceMoveToPosition
// ============================================================================
function canPieceMoveToPosition(currentPosition, diceNumber, maxPosition = 57) {
  if (typeof currentPosition !== 'number' || isNaN(currentPosition)) {
    return false;
  }

  const newPosition = currentPosition + diceNumber;
  return newPosition <= maxPosition;
}

// ============================================================================
// analyzePieceStates
// ============================================================================
function analyzePieceStates(pieces, diceNumber = null) {
  const piecesAtHome = pieces.filter(piece => {
    const atHome = !piece.from_pos_last || piece.to_pos_last === 'initial';
    return atHome;
  });

  const piecesNotAtHome = pieces.filter(piece => {
    const atHome = !piece.from_pos_last || piece.to_pos_last === 'initial';
    return !atHome;
  });

  const piecesAtGoal = pieces.filter(piece => {
    return piece.to_pos_last === 'goal' || piece.to_pos_last === 'finished';
  });

  let piecesCanMove = 0;
  let piecesStuck = 0;

  if (diceNumber && piecesNotAtHome.length > 0) {
    piecesNotAtHome.forEach(piece => {
      const currentPosition = piece.to_pos_last || piece.from_pos_last;
      const normalizedPosition = normalizePiecePosition(currentPosition);

      if (normalizedPosition !== null) {
        if (canPieceMoveToPosition(normalizedPosition, diceNumber, 57)) {
          piecesCanMove++;
        } else {
          piecesStuck++;
        }
      } else {
        piecesStuck++;
      }
    });
  }

  return {
    total: pieces.length,
    atHome: piecesAtHome.length,
    notAtHome: piecesNotAtHome.length,
    atGoal: piecesAtGoal.length,
    allAtHome: piecesAtHome.length === pieces.length,
    allAtGoal: piecesAtGoal.length === pieces.length,
    mixedState: piecesAtHome.length > 0 && piecesNotAtHome.length > 0,
    piecesCanMove: diceNumber ? piecesCanMove : null,
    piecesStuck: diceNumber ? piecesStuck : null,
    canMoveAny: diceNumber ? (piecesCanMove > 0 || (diceNumber === 6 && piecesAtHome.length > 0)) : null
  };
}

// ============================================================================
// getUserPieces
// ============================================================================
async function getUserPieces(gameID, userID, match = null) {
  let pieces = null;
  try {
    if (match) {
      if (sameId(userID, match.user1_id) && match.user1_pieces) {
        pieces = match.user1_pieces;
      } else if (sameId(userID, match.user2_id) && match.user2_pieces) {
        pieces = match.user2_pieces;
      }
    }
    if (!pieces && match) {
      const { loadPiecesIntoMatchState } = require('../../helpers/ludo/pieceMoveHelpers');
      const loadSuccess = await loadPiecesIntoMatchState(gameID, userID);
      if (loadSuccess) {
        const matchKey = REDIS_KEYS.MATCH(gameID);
        const matchRaw = await redisClient.get(matchKey);
        if (matchRaw) {
          const updatedMatch = safeParseRedisData(matchRaw);
          if (updatedMatch) {
            if (sameId(userID, updatedMatch.user1_id) && updatedMatch.user1_pieces) {
              pieces = updatedMatch.user1_pieces;
            } else if (sameId(userID, updatedMatch.user2_id) && updatedMatch.user2_pieces) {
              pieces = updatedMatch.user2_pieces;
            }
          }
        }
      }
    }
    if (!pieces) {
      pieces = await getUserPiecesCurrentState(gameID, userID);
    }
  } catch (err) {
    throw err;
  }
  return pieces;
}


// ============================================================================
// canMoveAnyPiece
// ============================================================================
async function canMoveAnyPiece(gameID, userID, diceNumber, match = null) {
  try {
    const pieces = await getUserPieces(gameID, userID, match);

    if (diceNumber == null) {
      return pieces.length > 0;
    }

    for (const piece of pieces) {
      const atHome = !piece.from_pos_last || piece.to_pos_last === 'initial';
      const currentPosition = piece.to_pos_last || piece.from_pos_last;

      if (atHome && diceNumber === 6) {
        return true;
      }

      if (!atHome) {
        const normalizedPosition = normalizePiecePosition(currentPosition);
        if (normalizedPosition !== null) {
          const canMove = canPieceMoveToPosition(normalizedPosition, diceNumber, 57);
          if (canMove) {
            return true;
          }
        }
      }
    }

    return false;
  } catch (err) {
    return false;
  }
}

// ============================================================================
// isFirstMove
// ============================================================================
function isFirstMove(match) {
  return (
    match.start_time &&
    match.user1_time === match.start_time &&
    match.user2_time === match.start_time
  );
}

// ============================================================================
// getFirstSixKey
// ============================================================================
function getFirstSixKey(match, user_id) {
  if (sameId(user_id, match.user1_id)) return 'first_six_rolled_user1';
  if (sameId(user_id, match.user2_id)) return 'first_six_rolled_user2';
  return null;
}

// ============================================================================
// getConsecutiveSixKey
// ============================================================================
function getConsecutiveSixKey(match, user_id) {
  if (sameId(user_id, match.user1_id)) return 'consecutive_six_user1';
  if (sameId(user_id, match.user2_id)) return 'consecutive_six_user2';
  return null;
}

// ============================================================================
// getTotalRollsKey
// ============================================================================
function getTotalRollsKey(match, user_id) {
  if (sameId(user_id, match.user1_id)) return 'total_rolls_user1';
  if (sameId(user_id, match.user2_id)) return 'total_rolls_user2';
  return null;
}

// ============================================================================
// getLastSixGetKey
// ============================================================================
function getLastSixGetKey(match, user_id) {
  if (sameId(user_id, match.user1_id)) return 'last_six_get_user1';
  if (sameId(user_id, match.user2_id)) return 'last_six_get_user2';
  return null;
}

// ============================================================================
// getIsFirstSixKey
// ============================================================================
function getIsFirstSixKey(match, user_id) {
  if (sameId(user_id, match.user1_id)) return 'is_first_six_user1';
  if (sameId(user_id, match.user2_id)) return 'is_first_six_user2';
  return null;
}

// ============================================================================
// getGuaranteedSixTurnsKey
// ============================================================================
function getGuaranteedSixTurnsKey(match, user_id) {
  if (sameId(user_id, match.user1_id)) return 'guaranteed_six_turns_user1';
  if (sameId(user_id, match.user2_id)) return 'guaranteed_six_turns_user2';
  return null;
}

// ============================================================================
// getInGuaranteedSixModeKey
// ============================================================================
function getInGuaranteedSixModeKey(match, user_id) {
  if (sameId(user_id, match.user1_id)) return 'in_guaranteed_six_mode_user1';
  if (sameId(user_id, match.user2_id)) return 'in_guaranteed_six_mode_user2';
  return null;
}

// ============================================================================
// getGuaranteedSixTurnsRemainingKey
// ============================================================================
function getGuaranteedSixTurnsRemainingKey(match, user_id) {
  if (sameId(user_id, match.user1_id)) return 'guaranteed_six_turns_remaining_user1';
  if (sameId(user_id, match.user2_id)) return 'guaranteed_six_turns_remaining_user2';
  return null;
}

// ============================================================================
// checkFirstSixGuarantee
// ============================================================================
function checkFirstSixGuarantee(match, user_id, totalRolls) {
  const firstSixKey = getFirstSixKey(match, user_id);
  const guaranteedSixTurnsKey = getGuaranteedSixTurnsKey(match, user_id);
  const inGuaranteedSixModeKey = getInGuaranteedSixModeKey(match, user_id);
  const guaranteedSixTurnsRemainingKey = getGuaranteedSixTurnsRemainingKey(match, user_id);

  if (match[guaranteedSixTurnsKey] === undefined) {
    match[guaranteedSixTurnsKey] = [];
  }
  if (match[inGuaranteedSixModeKey] === undefined) {
    match[inGuaranteedSixModeKey] = false;
  }
  if (match[guaranteedSixTurnsRemainingKey] === undefined) {
    match[guaranteedSixTurnsRemainingKey] = 0;
  }

  const hasRolledFirstSix = match[firstSixKey] || false;


  if (!hasRolledFirstSix && totalRolls >= 5 && !match[inGuaranteedSixModeKey]) {
    const guaranteedTurns = [];
    const startTurn = 6;
    const endTurn = 10;

    while (guaranteedTurns.length < 3) {
      const randomTurn = Math.floor(Math.random() * (endTurn - startTurn + 1)) + startTurn;
      if (!guaranteedTurns.includes(randomTurn)) {
        guaranteedTurns.push(randomTurn);
      }
    }

    guaranteedTurns.sort((a, b) => a - b);

    match[guaranteedSixTurnsKey] = guaranteedTurns;
    match[inGuaranteedSixModeKey] = true;
    match[guaranteedSixTurnsRemainingKey] = 3;

  }

  const isGuaranteedSix = match[guaranteedSixTurnsKey].includes(totalRolls);

  if (isGuaranteedSix) {
    match[guaranteedSixTurnsRemainingKey] = Math.max(0, match[guaranteedSixTurnsRemainingKey] - 1);

    if (match[guaranteedSixTurnsRemainingKey] === 0) {
      match[inGuaranteedSixModeKey] = false;
    }
  }

  return {
    isGuaranteedSix,
    hasRolledFirstSix,
    inGuaranteedSixMode: match[inGuaranteedSixModeKey],
    guaranteedTurnsRemaining: match[guaranteedSixTurnsRemainingKey],
    guaranteedTurns: match[guaranteedSixTurnsKey]
  };
}

// ============================================================================
// addDiceSixTracking
// ============================================================================
function addDiceSixTracking(match, user_id, diceNumber) {
  const totalRollsKey = getTotalRollsKey(match, user_id);
  const lastSixGetKey = getLastSixGetKey(match, user_id);
  const isFirstSixKey = getIsFirstSixKey(match, user_id);

  if (!match[totalRollsKey]) {
    match[totalRollsKey] = 0;
  }
  if (!match[lastSixGetKey]) {
    match[lastSixGetKey] = 0;
  }
  if (match[isFirstSixKey] === undefined) {
    match[isFirstSixKey] = false;
  }

  match[totalRollsKey] = (match[totalRollsKey] || 0) + 1;

  const isSix = diceNumber === 6;
  let isFirstSix = false;

  if (isSix) {
    isFirstSix = !match[getFirstSixKey(match, user_id)];
    match[lastSixGetKey] = match[totalRollsKey];
    match[isFirstSixKey] = isFirstSix;
  }

  const guaranteeCheck = checkFirstSixGuarantee(match, user_id, match[totalRollsKey]);

  const diceSixTracking = {
    isFirstSix: isFirstSix,
    totalRolls: match[totalRollsKey],
    lastSixGet: match[lastSixGetKey],
    isGuaranteedSix: guaranteeCheck.isGuaranteedSix,
    inGuaranteedSixMode: guaranteeCheck.inGuaranteedSixMode,
    guaranteedTurnsRemaining: guaranteeCheck.guaranteedTurnsRemaining
  };

  return diceSixTracking;
}

// ============================================================================
// getTimerKey
// ============================================================================
function getTimerKey(match, user_id) {
  if (sameId(match.user1_id, user_id)) return 'user1_time';
  if (sameId(match.user2_id, user_id)) return 'user2_time';
  return null;
}

// ============================================================================
// handleInvalidUser
// ============================================================================
function handleInvalidUser(socket, user_id) {
  emitStandardError(socket, {
    code: 'invalid_user',
    type: 'data',
    field: 'user_id',
    message: 'User not part of this match'
  }, 'dice:roll:response');
}

// ============================================================================
// handleNotUserTurn
// ============================================================================
function handleNotUserTurn(socket, user_id) {
  emitStandardError(socket, {
    code: 'turn_expired',
    type: 'game',
    message: 'It is not your turn.'
  }, 'dice:roll:response');
}

// ============================================================================
// handleTurnTimeout
// ============================================================================
async function handleTurnTimeout(socket, match, user_id, timeKey, opponentTimeKey, matchKey, redisClient) {
  try {
    const now = new Date();
    const opponentId = sameId(user_id, match.user1_id) ? match.user2_id : match.user1_id;

    match[timeKey] = now.toISOString();
    match[opponentTimeKey] = now.toISOString();
    match.turn = opponentId;
    await redisClient.set(matchKey, JSON.stringify(match));
    emitStandardError(socket, {
      code: 'turn_timeout',
      type: 'game',
      message: 'Turn forfeited due to timeout'
    }, 'dice:roll:response');
  } catch (err) {
    emitStandardError(socket, {
      code: 'timeout_error',
      type: 'system',
      message: err.message || 'Failed to handle turn timeout'
    }, 'dice:roll:response');
  }
}

// ============================================================================
// tryProcessDiceRoll
// ============================================================================
async function tryProcessDiceRoll(socket, processDiceRoll, params, user_id, match) {
  try {
    const response = await processDiceRoll(params, user_id, match);
    return response;
  } catch (err) {
    const errorMsg = err?.message ||
      (typeof err === 'string' ? err : String(err)) ||
      'Failed to roll dice';
    emitStandardError(socket, {
      code: 'verification_error',
      type: 'system',
      field: 'dice_roll',
      message: errorMsg,
      status: 'error'
    }, 'dice:roll:response');
    return null;
  }
}


// ============================================================================
// validateGameState
// ============================================================================
function validateGameState(socket, match, user_id) {
  const timerKey = getTimerKey(match, user_id);

  if (!timerKey) {
    handleInvalidUser(socket, user_id);
    return { isValid: false };
  }

  if (!sameId(match.turn, user_id)) {
    handleNotUserTurn(socket, user_id);
    return { isValid: false };
  }

  return { isValid: true, timerKey };
}

// ============================================================================
// checkTurnTimeout
// ============================================================================
async function checkTurnTimeout(socket, match, user_id, game_id) {
  try {
    const now = new Date();
    const timeKey = sameId(match.turn, match.user1_id) ? 'user1_time' : 'user2_time';
    const opponentTimeKey = sameId(match.turn, match.user1_id) ? 'user2_time' : 'user1_time';
    const isFirst = isFirstMove(match);

    if (!isFirst) {
      const lastMoveTime = match[timeKey] ? new Date(match[timeKey]) : null;

      if (!lastMoveTime || isNaN(lastMoveTime.getTime())) {
        match[timeKey] = now.toISOString();
      } else {
        const diffSec = (now - lastMoveTime) / 1000;
        if (diffSec > GAME_CONFIG.TIMING.ALLOWED_TURN_DELAY_SECONDS) {
          await handleTurnTimeout(socket, match, user_id, timeKey, opponentTimeKey, REDIS_KEYS.MATCH(game_id), redisClient);
          return { hasTimeout: true };
        }
      }
    }

    return { hasTimeout: false, timeKey, opponentTimeKey };
  } catch (err) {
    emitStandardError(socket, {
      code: 'timeout_check_error',
      type: 'system',
      message: err.message || 'Failed to check turn timeout'
    }, 'dice:roll:response');
    return { hasTimeout: true };
  }
}


// ============================================================================
// checkPieceMovement
// ============================================================================
async function checkPieceMovement(game_id, user_id, match, diceNumber) {
  let pieces = null;
  try {
    pieces = await getUserPieces(game_id, user_id, match);

    const pieceAnalysis = analyzePieceStates(pieces, diceNumber);

    if (pieceAnalysis.allAtHome) {
      if (diceNumber === 6) {
        return {
          canMoveAnyBeforeRoll: true,
          shouldPassTurnBeforeRoll: false,
          allPiecesAtHome: true,
          needsSixToStart: true,
          canStartWithSix: true,
          pieceAnalysis
        };
      } else {
        return {
          canMoveAnyBeforeRoll: false,
          shouldPassTurnBeforeRoll: true,
          allPiecesAtHome: true,
          needsSixToStart: true,
          canStartWithSix: false,
          pieceAnalysis
        };
      }
    }

    if (pieceAnalysis.mixedState) {
      const canMoveAny = pieceAnalysis.canMoveAny;

      return {
        canMoveAnyBeforeRoll: canMoveAny,
        shouldPassTurnBeforeRoll: !canMoveAny,
        allPiecesAtHome: false,
        needsSixToStart: false,
        mixedPiecesState: true,
        pieceAnalysis
      };
    }

    if (pieceAnalysis.canMoveAny !== null) {
      const canMoveAnyBeforeRoll = pieceAnalysis.canMoveAny;
      const shouldPassTurnBeforeRoll = !canMoveAnyBeforeRoll;

      return {
        canMoveAnyBeforeRoll,
        shouldPassTurnBeforeRoll,
        allPiecesAtHome: false,
        needsSixToStart: false,
        pieceAnalysis
      };
    } else {
      const canMoveAnyBeforeRoll = await canMoveAnyPiece(game_id, user_id, null, match);
      const shouldPassTurnBeforeRoll = !canMoveAnyBeforeRoll;

      return {
        canMoveAnyBeforeRoll,
        shouldPassTurnBeforeRoll,
        allPiecesAtHome: false,
        needsSixToStart: false,
        pieceAnalysis
      };
    }
  } catch (err) {
    return {
      canMoveAnyBeforeRoll: false,
      shouldPassTurnBeforeRoll: true,
      allPiecesAtHome: false,
      needsSixToStart: false
    };
  }
}

// ============================================================================
// checkIfAllPiecesNeedLessThanSix
// ============================================================================
async function checkIfAllPiecesNeedLessThanSix(game_id, user_id, match, diceNumber) {
  const HOME_POSITION = 57;
  try {
    const pieces = await getUserPieces(game_id, user_id, match);

    if (!pieces || pieces.length === 0) {
      return { needsLess: false, minDistance: null };
    }

    let allNeedLess = true;
    let minDistance = null;
    let hasMovablePieces = false;

    for (const piece of pieces) {
      const atHome = !piece.from_pos_last || piece.to_pos_last === 'initial';
      const atGoal = piece.to_pos_last === 'goal' || piece.to_pos_last === 'finished';

      if (atHome || atGoal) {
        continue;
      }

      hasMovablePieces = true;
      const currentPosition = normalizePiecePosition(piece.to_pos_last || piece.from_pos_last);
      if (currentPosition === null) {
        continue;
      }

      const distanceToHome = HOME_POSITION - currentPosition;

      if (distanceToHome >= diceNumber) {
        allNeedLess = false;
        break;
      }

      if (distanceToHome > 0) {
        if (minDistance === null || distanceToHome < minDistance) {
          minDistance = distanceToHome;
        }
      }
    }

    return { needsLess: allNeedLess && hasMovablePieces && minDistance !== null, minDistance };
  } catch (err) {
    return { needsLess: false, minDistance: null };
  }
}

// ============================================================================
// handleFirstTimeRoll
// ============================================================================
function handleFirstTimeRoll(match, user_id, response, canMoveAfterRoll, opponentId) {
  const firstSixKey = getFirstSixKey(match, user_id);
  const consecutiveSixKey = getConsecutiveSixKey(match, user_id);
  const updatedNow = new Date();

  // Use consecutive six count from response (already calculated in processDiceRoll)
  const consecutiveSixes = response.consecutive_sixes || 0;
  match[consecutiveSixKey] = consecutiveSixes;

  if (response.dice_number === 6) {
    match[firstSixKey] = true;

    // Check if this is the 3rd consecutive six (already calculated in processDiceRoll)
    if (consecutiveSixes >= 3) {
      match.turn = opponentId;
      match[consecutiveSixKey] = 0;
      match.user1_time = updatedNow.toISOString();
      match.user2_time = updatedNow.toISOString();
      response.turn_passed = true;
      response.can_move_pieces = false;
      response.gets_another_turn = false;
      response.message = 'You rolled 3 consecutive sixes! Turn passes to opponent.';
      response.consecutive_sixes = 3;
      response.special_rule = 'three_consecutive_sixes';
      return;
    }

    match.turn = user_id;
    match.user1_time = updatedNow.toISOString();
    match.user2_time = updatedNow.toISOString();
    response.gets_another_turn = true;
    response.turn_passed = false;
    if (!response.message) {
      response.message = 'You rolled a 6! You get another turn!';
    }
  } else if (canMoveAfterRoll) {
    match[firstSixKey] = true;
    match[consecutiveSixKey] = 0; // Reset on non-six
    match.turn = user_id;
    match.user1_time = updatedNow.toISOString();
    match.user2_time = updatedNow.toISOString();
    response.gets_another_turn = false;
    response.turn_passed = false;
  } else {
    match[consecutiveSixKey] = 0; // Reset on non-six
    match.turn = opponentId;
    match.user1_time = updatedNow.toISOString();
    match.user2_time = updatedNow.toISOString();
    response.gets_another_turn = false;
    response.turn_passed = true;
  }
}

// ============================================================================
// handleAllPiecesAtHomeLogic
// ============================================================================
function handleAllPiecesAtHomeLogic(match, user_id, response, canStartWithSix, opponentId) {
  const updatedNow = new Date();
  const firstSixKey = getFirstSixKey(match, user_id);

  if (canStartWithSix) {
    if (response.dice_number === 6 && firstSixKey) {
      match[firstSixKey] = true;
    }
    match.turn = user_id;
    match.user1_time = updatedNow.toISOString();
    match.user2_time = updatedNow.toISOString();
    if (response.dice_number === 6) {
      response.gets_another_turn = true;
      response.turn_passed = false;
    } else {
      response.gets_another_turn = false;
      response.turn_passed = false;
    }
  } else {
    match.turn = opponentId;
    match.user1_time = updatedNow.toISOString();
    match.user2_time = updatedNow.toISOString();
    response.gets_another_turn = false;
    response.turn_passed = true;
  }
}

// ============================================================================
// handleSubsequentRoll
// ============================================================================
function handleSubsequentRoll(match, user_id, response, canMoveAfterRoll, opponentId) {
  const updatedNow = new Date();
  const consecutiveSixKey = getConsecutiveSixKey(match, user_id);

  // Use consecutive six count from response (already calculated in processDiceRoll)
  const consecutiveSixes = response.consecutive_sixes || 0;
  match[consecutiveSixKey] = consecutiveSixes;

  if (response.dice_number === 6) {
    // Check if this is the 3rd consecutive six (already calculated in processDiceRoll)
    if (consecutiveSixes >= 3) {
      match.turn = opponentId;
      match[consecutiveSixKey] = 0;
      match.user1_time = updatedNow.toISOString();
      match.user2_time = updatedNow.toISOString();
      response.turn_passed = true;
      response.can_move_pieces = false;
      response.gets_another_turn = false;
      response.message = 'You rolled 3 consecutive sixes! Turn passes to opponent.';
      response.consecutive_sixes = 3;
      response.special_rule = 'three_consecutive_sixes';
      return;
    }

    match.turn = user_id;
    match.user1_time = updatedNow.toISOString();
    match.user2_time = updatedNow.toISOString();
    response.gets_another_turn = true;
    response.turn_passed = false;
    if (!response.message) {
      response.message = 'You rolled a 6! You get another turn!';
    }
    return;
  }

  // Reset counter for non-six (already set to 0 in processDiceRoll)
  match[consecutiveSixKey] = 0;

  if (canMoveAfterRoll) {
    match.turn = user_id;
    match.user1_time = updatedNow.toISOString();
    match.user2_time = updatedNow.toISOString();
    response.gets_another_turn = false;
    response.turn_passed = false;
  } else {
    match.turn = opponentId;
    match.user1_time = updatedNow.toISOString();
    match.user2_time = updatedNow.toISOString();
    response.gets_another_turn = false;
    response.turn_passed = true;
  }
}

// ============================================================================
// manageTurnLogic
// ============================================================================
async function manageTurnLogic(match, user_id, response, pieceCheck) {
  const firstSixKey = getFirstSixKey(match, user_id);
  const isFirstSixNotRolled = !match[firstSixKey];
  const canMoveAfterRoll = await canMoveAnyPiece(match.game_id || 'temp', user_id, response.dice_number, match);
  const opponentId = sameId(match.turn, match.user1_id) ? match.user2_id : match.user1_id;

  if (pieceCheck.allPiecesAtHome && pieceCheck.needsSixToStart) {
    handleAllPiecesAtHomeLogic(match, user_id, response, pieceCheck.canStartWithSix, opponentId);
    return;
  }

  if (!pieceCheck.allPiecesAtHome && !pieceCheck.needsSixToStart) {
    if (pieceCheck.mixedPiecesState) {
      if (canMoveAfterRoll) {
        match.turn = user_id;
        match.user1_time = new Date().toISOString();
        match.user2_time = new Date().toISOString();
        response.gets_another_turn = false;
        response.turn_passed = false;
      } else {
        if (response.dice_number === 6) {
          match.turn = user_id;
          match.user1_time = new Date().toISOString();
          match.user2_time = new Date().toISOString();
          response.can_move_pieces = false;
          response.turn_passed = false;
          response.gets_another_turn = true;
          response.message = `Rolled 6 but no legal move; extra roll granted`;
        } else {
          match.turn = opponentId;
          match.user1_time = new Date().toISOString();
          match.user2_time = new Date().toISOString();
          response.gets_another_turn = false;
          response.turn_passed = true;
        }
      }

      return;
    }
  }

  if (isFirstSixNotRolled) {
    handleFirstTimeRoll(match, user_id, response, canMoveAfterRoll, opponentId);
  } else {
    handleSubsequentRoll(match, user_id, response, canMoveAfterRoll, opponentId);
  }

}

async function processDiceRollFlow(io, socket, user, diceData, responseGuarantee) {
  if (!validateRequestFields(socket, diceData)) {
    responseGuarantee.markAsSent();
    return;
  }

  const game_id = normalizeIdValue(diceData.game_id), user_id = normalizeIdValue(diceData.user_id || user.user_id);
  const match = await fetchMatchOrEmitError(socket, game_id, redisClient, 'dice:roll:response');
  if (!match) {
    responseGuarantee.markAsSent();
    return;
  }

  if (isGameCompleted(socket, match)) {
    responseGuarantee.markAsSent();
    return;
  }

  const gameState = validateGameState(socket, match, user_id);
  if (!gameState.isValid) {
    responseGuarantee.markAsSent();
    return;
  }

  const timeoutCheck = await checkTurnTimeout(socket, match, user_id, game_id);
  if (timeoutCheck.hasTimeout) {
    responseGuarantee.markAsSent();
    return;
  }

  const response = await handleDiceRollProcess(socket, diceData, user_id, match);
  if (!response) {
    responseGuarantee.markAsSent();
    return;
  }

  response.dice_six_tracking = addDiceSixTracking(match, user_id, response.dice_number);
  await scoreDiceRollAndUpdateResponse(response, match, user_id);

  if (!match.turnCount) {
    match.turnCount = {};
  }
  if (!match.previousTurn || !sameId(match.previousTurn, user_id)) {
    match.turnCount[user_id] = (match.turnCount[user_id] || 0) + 1;
  }
  match.previousTurn = user_id;

  const pieceCheck = await checkPieceMovement(game_id, user_id, match, response.dice_number);

  if (response.dice_number === 6) {
    const needsLessThanSix = await checkIfAllPiecesNeedLessThanSix(game_id, user_id, match, response.dice_number);
    if (needsLessThanSix.needsLess) {
      const now = new Date().toISOString();
      match.user1_time = now;
      match.user2_time = now;
      match.turn = user_id;
      match.last_rolled_dice = null;
      match.last_rolled_dice_user = null;

      response.can_move_pieces = false;
      response.turn_passed = false;
      response.gets_another_turn = true;
      response.message = 'You rolled 6 but all your pieces need less than 6 to reach home. You cannot move. Timer reset. Roll again!';
      response.needs_less_than_six = true;
      response.min_distance_needed = needsLessThanSix.minDistance;
    } else {
      response.gets_another_turn = true;
      response.turn_passed = false;
      if (!response.message) {
        response.message = 'You rolled a 6! You get another turn!';
      }
    }
  } else {
    response.gets_another_turn = false;
  }

  await manageTurnLogic(match, user_id, response, pieceCheck);

  try {
    const partialUpdate = {};
    if (typeof match.turn !== 'undefined') partialUpdate.turn = match.turn;
    if (typeof match.user1_time !== 'undefined') partialUpdate.user1_time = match.user1_time;
    if (typeof match.user2_time !== 'undefined') partialUpdate.user2_time = match.user2_time;
    if (typeof match.user1_score !== 'undefined') partialUpdate.user1_score = match.user1_score;
    if (typeof match.user2_score !== 'undefined') partialUpdate.user2_score = match.user2_score;
    if (typeof match.scores !== 'undefined') partialUpdate.scores = match.scores;
    if (typeof match.turnCount !== 'undefined') partialUpdate.turnCount = match.turnCount;
    if (typeof match.previousTurn !== 'undefined') partialUpdate.previousTurn = match.previousTurn;
    if (typeof match.first_six_rolled_user1 !== 'undefined') partialUpdate.first_six_rolled_user1 = match.first_six_rolled_user1;
    if (typeof match.first_six_rolled_user2 !== 'undefined') partialUpdate.first_six_rolled_user2 = match.first_six_rolled_user2;
    if (typeof match.consecutive_six_user1 !== 'undefined') partialUpdate.consecutive_six_user1 = match.consecutive_six_user1;
    if (typeof match.consecutive_six_user2 !== 'undefined') partialUpdate.consecutive_six_user2 = match.consecutive_six_user2;
    if (typeof match.guaranteed_six_turns_user1 !== 'undefined') partialUpdate.guaranteed_six_turns_user1 = match.guaranteed_six_turns_user1;
    if (typeof match.guaranteed_six_turns_user2 !== 'undefined') partialUpdate.guaranteed_six_turns_user2 = match.guaranteed_six_turns_user2;
    if (typeof match.in_guaranteed_six_mode_user1 !== 'undefined') partialUpdate.in_guaranteed_six_mode_user1 = match.in_guaranteed_six_mode_user1;
    if (typeof match.in_guaranteed_six_mode_user2 !== 'undefined') partialUpdate.in_guaranteed_six_mode_user2 = match.in_guaranteed_six_mode_user2;
    if (typeof match.guaranteed_six_turns_remaining_user1 !== 'undefined') partialUpdate.guaranteed_six_turns_remaining_user1 = match.guaranteed_six_turns_remaining_user1;
    if (typeof match.guaranteed_six_turns_remaining_user2 !== 'undefined') partialUpdate.guaranteed_six_turns_remaining_user2 = match.guaranteed_six_turns_remaining_user2;
    partialUpdate.updated_at = new Date().toISOString();
    const merged = await saveMatchFields(redisClient, game_id, partialUpdate);
    if (!merged) {
      await saveMatchState(redisClient, game_id, match);
    }
  } catch (saveError) {
    await saveMatchState(redisClient, game_id, match);
  }

  try {
    await notifyPlayers(socket, io, game_id, match, response, user_id, responseGuarantee);
  } catch (notifyErr) {
    logDiceHandlerError('notifyPlayers failed, sending response directly', notifyErr, { gameID: game_id });
    if (!responseGuarantee.isResponseSent()) {
      try {
        response.turn = match.turn;
        responseGuarantee.sendResponse(response);
      } catch (emitErr) {
        logDiceHandlerError('Failed to emit dice roll response', emitErr, { gameID: game_id });
      }
    }
  }
}

// ============================================================================
// validateRequestFields
// ============================================================================
function validateRequestFields(socket, diceData) {
  const requiredFields = ['game_id', 'contest_id', 'l_id', 'user_id'];
  if (!validateRequiredFields(socket, diceData, requiredFields, 'dice:roll:response')) {
    return false;
  }

  const invalidField = requiredFields.find((field) => !isNonEmptyString(diceData[field]));
  if (invalidField) {
    emitStandardError(socket, {
      code: 'invalid_value',
      type: 'validation',
      field: invalidField,
      message: `${invalidField} is required and must be a non-empty string.`
    }, 'dice:roll:response');
    return false;
  }

  return true;
}

// ============================================================================
// isGameCompleted
// ============================================================================
function isGameCompleted(socket, match) {
  if (match.status === GAME_STATUS.COMPLETED) {
    emitStandardError(socket, {
      code: 'game_already_completed',
      type: 'game',
      field: 'game_status',
      message: 'This game is already completed. No more dice rolls allowed.'
    }, 'dice:roll:response');
    return true;
  }
  return false;
}

// ============================================================================
// handleDiceRollProcess
// ============================================================================
async function handleDiceRollProcess(socket, diceData, user_id, match) {
  return await tryProcessDiceRoll(socket, processDiceRoll, {
    game_id: diceData.game_id,
    contest_id: diceData.contest_id,
    session_token: diceData.session_token,
    device_id: diceData.device_id,
    jwt_token: diceData.jwt_token
  }, user_id, match);
}

// ============================================================================
// scoreDiceRollAndUpdateResponse
// ============================================================================
async function scoreDiceRollAndUpdateResponse(response, match, user_id) {
  try {
    // Use consecutive six count from response (already calculated correctly in processDiceRoll)
    const consecutiveSixes = response.consecutive_sixes || 0;

    const gameContext = {
      isFirstSix: !match.first_six_rolled_user1 && !match.first_six_rolled_user2,
      consecutiveSixes: consecutiveSixes,
      turnCount: match.turnCount || 1
    };

    const matchPairId = match.match_pair_id || response.game_id;
    const scoreResult = await scoreDiceRoll(user_id, response.dice_number, matchPairId, gameContext);

    if (scoreResult.points > 0) {
      if (sameId(match.user1_id, user_id)) {
        match.user1_score = (parseInt(match.user1_score) || 0) + scoreResult.points;
      } else if (sameId(match.user2_id, user_id)) {
        match.user2_score = (parseInt(match.user2_score) || 0) + scoreResult.points;
      }

      if (!match.scores) {
        match.scores = {};
      }
      match.scores[user_id] = (parseInt(match.scores[user_id]) || 0) + scoreResult.points;

      match.updated_at = new Date().toISOString();
    }

    response.score_earned = scoreResult.points;
    response.score_reasons = scoreResult.reasons;
    response.bonus_score = scoreResult.bonusScore;
    response.total_score = scoreResult.points;
    response.match_pair_id = matchPairId;
  } catch (scoreError) {
    response.score_earned = 0;
    response.score_reasons = ['scoring_failed'];
  }
}

// ============================================================================
// notifyPlayers
// ============================================================================
async function notifyPlayers(socket, io, game_id, match, response, user_id, responseGuarantee = null) {
  try {
    response.turn = match.turn;
    response.user1_score = parseInt(match.user1_score) || 0;
    response.user2_score = parseInt(match.user2_score) || 0;

    // Ensure gets_another_turn is set based on turn
    if (response.dice_number === 6 && sameId(match.turn, user_id) && !response.gets_another_turn) {
      response.gets_another_turn = true;
    } else if (!sameId(match.turn, user_id) && response.gets_another_turn !== false) {
      response.gets_another_turn = false;
    }

    // Use response guarantee if provided, otherwise direct emit
    if (responseGuarantee) {
      responseGuarantee.sendResponse(response);
    } else {
      // Fallback to direct emit if no response guarantee
      socket.emit('dice:roll:response', response);
    }

    // Then notify opponent (this can fail without affecting user response)
    try {
      const opponentSocketId = await findActiveOpponentSocketId(io, game_id, user_id, 'ludo');
      if (opponentSocketId) {
        await broadcastDiceRollToOpponent(io, opponentSocketId, response);
      }
    } catch (opponentErr) {
      // Log but don't throw - user response already sent
      logDiceHandlerError('Failed to notify opponent', opponentErr, { gameID: game_id });
    }
  } catch (err) {
    // If emit fails, ensure response is sent via guarantee
    if (responseGuarantee && !responseGuarantee.isResponseSent()) {
      responseGuarantee.sendResponse(response);
    } else if (!responseGuarantee) {
      // Fallback: try direct emit one more time
      try {
        socket.emit('dice:roll:response', response);
      } catch (emitErr) {
        logDiceHandlerError('Failed to emit dice roll response in error handler', emitErr, { gameID: game_id });
      }
    }
    logDiceHandlerError('notifyPlayers failed', err, { gameID: game_id });
    throw err;
  }
}

// ============================================================================
// registerDiceRollHandler
// ============================================================================
async function registerDiceRollHandler(io, socket) {
  socket.removeAllListeners('dice:roll');
  socket.on('dice:roll', async (event) => {
    // Create response guarantee to ensure user always gets a response
    const responseGuarantee = createResponseGuarantee(socket, 'dice:roll:response', 10000);

    try {
      await withAuth(socket, event, 'dice:roll:response', async (user, diceData) => {
        await processDiceRollFlow(io, socket, user, diceData, responseGuarantee);
      }).catch((authErr) => {
        // withAuth emits errors internally, but we need to track it
        // Check if withAuth already emitted (it uses emitError which emits to socket)
        // If socket is still connected and no response sent, send via guarantee
        if (!responseGuarantee.isResponseSent() && socket && socket.connected) {
          // withAuth already emitted, but mark as sent to prevent duplicate
          responseGuarantee.markAsSent();
        }
      });
    } catch (err) {
      logDiceHandlerError('registerDiceRollHandler top-level failure', err);
      // Ensure error response is sent only if withAuth didn't already send one
      if (!responseGuarantee.isResponseSent()) {
        responseGuarantee.sendError({
          code: 'handler_error',
          type: 'system',
          message: err.message || 'Failed to handle dice roll',
          event: 'dice:roll:response'
        });
      }
    } finally {
      responseGuarantee.cleanup();
    }
  });
}
module.exports = { registerDiceRollHandler };
