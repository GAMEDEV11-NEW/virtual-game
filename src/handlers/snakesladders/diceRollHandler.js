const { processDiceRoll, broadcastDiceRollToOpponent, getConsecutiveSixKey } = require('../../helpers/snakesladders/diceRollHelpers');
const { findActiveOpponentSocketId } = require('../../helpers/common/gameHelpers');
const { redis: redisClient } = require('../../utils/redis');
const { validateRequiredFields, emitStandardError, safeParseRedisData } = require('../../utils/gameUtils');
const withAuth = require('../../middleware/withAuth');
const { SNAKES_LADDERS_CONFIG } = require('../../config/snakesladdersConfig');
const { scoreDiceRoll } = require('../../services/snakesladders/scoreService');
const { 
  getUserPieces, 
  getMovablePieces
} = require('../../helpers/snakesladders/gameUtils');
const { REDIS_KEYS, GAME_STATUS } = require('../../constants');

async function saveSnakesLaddersMatchState(gameId, match) {
  const matchKey = REDIS_KEYS.SNAKES_MATCH(gameId);
  await redisClient.set(matchKey, JSON.stringify(match));
}

async function fetchMatchOrEmit(socket, gameId) {
  const matchKey = REDIS_KEYS.SNAKES_MATCH(gameId);
  const matchRaw = await redisClient.get(matchKey);
  if (!matchRaw) {
    emitStandardError(socket, {
      code: 'not_found',
      type: 'data',
      field: 'game_id',
      message: 'No match found',
      event: 'snakesladders_dice:roll:response'
    });
    return null;
  }

  const match = safeParseRedisData(matchRaw);
  if (!match) {
    emitStandardError(socket, {
      code: 'parse_error',
      type: 'data',
      field: 'game_id',
      message: 'Failed to parse game data',
      event: 'snakesladders_dice:roll:response'
    });
    return null;
  }
  return match;
}

function getTimerKey(match, user_id) {
  if (match.user1_id === user_id) return 'user1_timer';
  if (match.user2_id === user_id) return 'user2_timer';
  return null;
}

function validateUserTurn(socket, match, user_id) {
  if (match.turn !== user_id) {
    emitStandardError(socket, {
      code: 'turn_expired',
      type: 'game',
      message: 'It is not your turn to roll dice.',
      event: 'snakesladders_dice:roll:response',
    });
    return { isValid: false };
  }
  return { isValid: true };
}

function validateGameState(socket, match, user_id) {
  const timerKey = getTimerKey(match, user_id);

  if (!timerKey) {
    emitStandardError(socket, {
      code: 'invalid_user',
      type: 'data',
      field: 'user_id',
      message: 'User not part of this match',
      event: 'snakesladders_dice:roll:response',
    });
    return { isValid: false };
  }

  if (match[timerKey] <= 0) {
    emitStandardError(socket, {
      code: 'timer_expired',
      type: 'game',
      field: timerKey,
      message: 'Your timer has expired. Cannot roll dice.',
      event: 'timer_expired',
    });
    return { isValid: false };
  }

  const turnValidation = validateUserTurn(socket, match, user_id);
  if (!turnValidation.isValid) {
    return { isValid: false };
  }

  return { isValid: true, timerKey };
}

async function checkTurnTimeout(socket, match, user_id, game_id) {
  try {
    const now = new Date();
    const timeKey = match.turn === match.user1_id ? 'user1_time' : 'user2_time';
    const opponentTimeKey = match.turn === match.user1_id ? 'user2_time' : 'user1_time';

    const lastMoveTime = match[timeKey] ? new Date(match[timeKey]) : null;

    if (!lastMoveTime || isNaN(lastMoveTime.getTime())) {
      match[timeKey] = now.toISOString();
    } else {
      const diffSec = (now - lastMoveTime) / 1000;
      if (diffSec > SNAKES_LADDERS_CONFIG.TIMING.TURN_TIMEOUT_SECONDS) {
        await handleTurnTimeout(socket, match, user_id, timeKey, opponentTimeKey, REDIS_KEYS.SNAKES_MATCH(game_id), redisClient);
        return { hasTimeout: true };
      }
    }

    return { hasTimeout: false, timeKey, opponentTimeKey };
  } catch (err) {
    emitStandardError(socket, {
      code: 'timeout_check_error',
      type: 'system',
      message: err.message || 'Failed to check turn timeout',
      event: 'timer_expired',
    });
    return { hasTimeout: true };
  }
}

async function handleTurnTimeout(socket, match, user_id, timeKey, opponentTimeKey, matchKey, redisClient) {
  try {
    const now = new Date();
    const opponentId = user_id === match.user1_id ? match.user2_id : match.user1_id;

    match[timeKey] = now.toISOString();
    match[opponentTimeKey] = now.toISOString();
    match.turn = opponentId; 
    await redisClient.set(matchKey, JSON.stringify(match));
    emitStandardError(socket, {
      code: 'turn_timeout',
      type: 'game',
      message: 'Turn forfeited due to timeout',
      event: 'timer_expired',
    });
  } catch (err) {
    emitStandardError(socket, {
      code: 'timeout_error',
      type: 'system',
      message: err.message || 'Failed to handle turn timeout',
      event: 'timer_expired',
    });
  }
}

async function tryProcessDiceRoll(socket, processDiceRoll, params, user_id, match = null) {
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
      event: 'snakesladders_dice:roll:response',
      status: 'error',
    });
    return null;
  }
}

function validatePieceMovementCapabilities(userPieces, diceNumber) {
  if (!userPieces || userPieces.length === 0) {
    return {
      canMoveWithCurrentDice: false,
      canMoveAnyPiece: false,
      requiredNumbersToReach100: [],
      piecesThatCanMove: [],
      piecesAtWinningPosition: 0,
      shouldPassTurn: true,
      reason: 'No pieces available'
    };
  }

  const piecesThatCanMove = [];
  const requiredNumbersToReach100 = [];
  let piecesAtWinningPosition = 0;
  let canMoveWithCurrentDice = false;
  let canMoveAnyPiece = false;

  userPieces.forEach(piece => {
    const currentPosition = parseInt(piece.to_pos_last) || 0;
    
    if (currentPosition === SNAKES_LADDERS_CONFIG.TOTAL_SQUARES) {
      piecesAtWinningPosition++;
      return;
    }

    const newPosition = currentPosition + diceNumber;
    if (newPosition <= SNAKES_LADDERS_CONFIG.TOTAL_SQUARES) {
      canMoveWithCurrentDice = true;
      piecesThatCanMove.push({
        piece_id: piece.piece_id,
        currentPosition: currentPosition,
        newPosition: newPosition,
        canMove: true
      });
    }

    const distanceTo100 = SNAKES_LADDERS_CONFIG.TOTAL_SQUARES - currentPosition;
    if (distanceTo100 > 0 && distanceTo100 <= 6) {
      requiredNumbersToReach100.push({
        piece_id: piece.piece_id,
        currentPosition: currentPosition,
        requiredNumber: distanceTo100,
        canReach100: true
      });
    }

    for (let dice = 1; dice <= 6; dice++) {
      const testPosition = currentPosition + dice;
      if (testPosition <= SNAKES_LADDERS_CONFIG.TOTAL_SQUARES) {
        canMoveAnyPiece = true;
        break;
      }
    }
  });

  let shouldPassTurn = false;
  let reason = '';

  if (piecesAtWinningPosition === userPieces.length) {
    shouldPassTurn = false;
    reason = 'All pieces at winning position - game won';
  } else if (!canMoveWithCurrentDice && !canMoveAnyPiece) {
    shouldPassTurn = true;
    reason = 'No pieces can move with any dice number';
  } else if (!canMoveWithCurrentDice && canMoveAnyPiece) {
    shouldPassTurn = true;
    reason = `Cannot move with ${diceNumber}, but can move with other numbers`;
  } else if (canMoveWithCurrentDice) {
    shouldPassTurn = false;
    reason = 'Can move with current dice number';
  }

  return {
    canMoveWithCurrentDice,
    canMoveAnyPiece,
    requiredNumbersToReach100,
    piecesThatCanMove,
    piecesAtWinningPosition,
    shouldPassTurn,
    reason,
    totalPieces: userPieces.length,
    piecesRemaining: userPieces.length - piecesAtWinningPosition
  };
}

function analyzeRequiredNumbersFor100(userPieces) {
  if (!userPieces || userPieces.length === 0) {
    return {
      hasPiecesNeedingSpecificNumbers: false,
      piecesNeedingSpecificNumbers: [],
      allPiecesCanReach100: false,
      summary: 'No pieces available'
    };
  }

  const piecesNeedingSpecificNumbers = [];
  let allPiecesCanReach100 = true;

  userPieces.forEach(piece => {
    const currentPosition = parseInt(piece.to_pos_last) || 0;
    
    if (currentPosition === SNAKES_LADDERS_CONFIG.TOTAL_SQUARES) {
      return;
    }

    const distanceTo100 = SNAKES_LADDERS_CONFIG.TOTAL_SQUARES - currentPosition;
    
    if (distanceTo100 > 0) {
      if (distanceTo100 <= 6) {
        piecesNeedingSpecificNumbers.push({
          piece_id: piece.piece_id,
          currentPosition: currentPosition,
          requiredNumber: distanceTo100,
          canReach100: true
        });
      } else {
        allPiecesCanReach100 = false;
      }
    }
  });

  return {
    hasPiecesNeedingSpecificNumbers: piecesNeedingSpecificNumbers.length > 0,
    piecesNeedingSpecificNumbers,
    allPiecesCanReach100: allPiecesCanReach100 && piecesNeedingSpecificNumbers.length === userPieces.length,
    summary: `${piecesNeedingSpecificNumbers.length} pieces need specific numbers to reach 100`
  };
}

// ============================================================================
// shouldLoseTurnForConsecutiveSix
// ============================================================================
function shouldLoseTurnForConsecutiveSix(match, user_id) {
  const consecutiveSixKey = getConsecutiveSixKey(match, user_id);
  const consecutiveCount = match[consecutiveSixKey] || 0;
  return consecutiveCount >= 3;
}

async function registerDiceRollHandler(io, socket) {
  socket.on('snakesladders_dice:roll', async (event) => {
    try {
      await withAuth(socket, event, 'snakesladders_dice:roll:response', async (user) => {
        const { 
          game_id, 
          user_id,
          contest_id,
          session_token,
          device_id,
          jwt_token
        } = user;
        
        if (!validateRequestFields(socket, { game_id, user_id, contest_id, session_token, device_id, jwt_token })) return;

        const match = await fetchMatchOrEmit(socket, game_id);
        if (!match) return;

        if (isGameCompleted(socket, match)) return;

        const turnValidation = validateUserTurn(socket, match, user_id);
        if (!turnValidation.isValid) return;

        const gameState = validateGameState(socket, match, user_id);
        if (!gameState.isValid) return;

        const timeoutCheck = await checkTurnTimeout(socket, match, user_id, game_id);
        if (timeoutCheck.hasTimeout) return;

        const response = await handleDiceRollProcess(socket, { game_id, contest_id, session_token, device_id, jwt_token }, user_id, match);
        if (!response) return;

        const diceNumber = response.dice_number;
        const consecutiveSixKey = getConsecutiveSixKey(match, user_id);
        const userPieces = await getUserPieces(match, user_id);
        const movablePieces = getMovablePieces(userPieces, diceNumber);
        
        response.movable_pieces = movablePieces;
        response.user_pieces = userPieces;
        response.can_move_pieces = true;
        response.turn_passed = false;
        

        await scoreDiceRollAndUpdateResponse(response, match, user_id);

        const movementValidation = validatePieceMovementCapabilities(userPieces, diceNumber);
        const requiredNumbersAnalysis = analyzeRequiredNumbersFor100(userPieces);
        
        response.movement_validation = movementValidation;
        response.required_numbers_analysis = requiredNumbersAnalysis;
        

        let shouldPassTurn = false;
        let turnReason = '';
        const opponentId = user_id === match.user1_id ? match.user2_id : match.user1_id;
        
        // Check for 3 consecutive sixes first (this overrides other logic)
        if (diceNumber === 6 && shouldLoseTurnForConsecutiveSix(match, user_id)) {
          shouldPassTurn = true;
          turnReason = 'Rolled 3 consecutive sixes! Turn passes to opponent.';
          match[consecutiveSixKey] = 0; // Reset counter
          response.can_move_pieces = false;
          response.turn_passed = true;
          response.message = turnReason;
          response.consecutive_sixes = 3;
          response.special_rule = 'three_consecutive_sixes';
        } else if (movementValidation.piecesAtWinningPosition === movementValidation.totalPieces) {
          // Game won
          shouldPassTurn = false;
          match.winner = user_id;
          match.status = GAME_STATUS.COMPLETED;
          match.completed_at = new Date().toISOString();
          match.game_end_reason = 'player_won';
          // Reset consecutive six counter on game win
          if (consecutiveSixKey) {
            match[consecutiveSixKey] = 0;
          }
          try {
            const { cleanupRedisMatchData } = require('../../services/snakesladders/windeclearService');
            await cleanupRedisMatchData(game_id);
          } catch (_) {}
        } else {
          // Normal turn logic
          if (movementValidation.canMoveWithCurrentDice) {
            shouldPassTurn = false;
            turnReason = 'Can move with current dice number';
            // Reset consecutive six counter if not a six
            if (diceNumber !== 6 && consecutiveSixKey) {
              match[consecutiveSixKey] = 0;
            }
          } else if (diceNumber === 6) {
            // Rolled 6 but can't move - still get another turn (unless 3 consecutive)
            shouldPassTurn = false;
            turnReason = `Rolled 6 but no legal move; extra roll granted`;
            response.can_move_pieces = false;
            response.turn_passed = false;
            response.message = turnReason;
          } else {
            // Can't move with current dice
            shouldPassTurn = true;
            // Reset consecutive six counter when not rolling six
            if (consecutiveSixKey) {
              match[consecutiveSixKey] = 0;
            }
            if (movementValidation.canMoveAnyPiece) {
              turnReason = `Cannot move with ${diceNumber}, but can move with other numbers`;
            } else {
              turnReason = 'No pieces can move with any dice number';
            }
          }
        }
        
        if (shouldPassTurn) {
          match.turn = opponentId;
          if (!response.message) {
            response.message = `${turnReason}. Turn passes to opponent.`;
          }
        } else {
          match.turn = user_id;
        }

        if (!match.turnCount) {
          match.turnCount = {};
        }
        
        if (!match.previousTurn || match.previousTurn !== user_id) {
          match.turnCount[user_id] = (match.turnCount[user_id] || 0) + 1;
        }
        match.previousTurn = user_id;

        const now = new Date().toISOString();
        match.user1_time = now;
        match.user2_time = now;
        match.updated_at = now;

        // Ensure consecutive six counters are saved
        if (match.consecutive_six_user1 !== undefined) {
          match.consecutive_six_user1 = match.consecutive_six_user1 || 0;
        }
        if (match.consecutive_six_user2 !== undefined) {
          match.consecutive_six_user2 = match.consecutive_six_user2 || 0;
        }

        await saveSnakesLaddersMatchState(game_id, match);

        try {
          await notifyPlayers(socket, io, game_id, match, response, user_id);
        } catch (notifyErr) {
          // If notifyPlayers fails, still send response to user
          try {
            response.turn = match.turn;
            response.game_type = 'snakes_ladders';
            response.user1_pieces = match.user1_pieces || [];
            response.user2_pieces = match.user2_pieces || [];
            socket.emit('snakesladders_dice:roll:response', response);
          } catch (emitErr) {
            // Log error but don't block
          }
        }
      });
    } catch (err) {
      emitStandardError(socket, {
        code: 'handler_error',
        type: 'system',
        message: err.message || 'Failed to handle dice roll',
        event: 'snakesladders_dice:roll:response',
      });
    }
  });
}

function validateRequestFields(socket, diceData) {
  const requiredFields = ['game_id', 'contest_id', 'session_token', 'device_id', 'jwt_token'];
  return validateRequiredFields(socket, diceData, requiredFields, 'snakesladders_dice:roll:response');
}

function isGameCompleted(socket, match) {
  if (match.status === GAME_STATUS.COMPLETED) {
    emitStandardError(socket, {
      code: 'game_already_completed',
      type: 'game',
      field: 'game_status',
      message: 'This game is already completed. No more dice rolls allowed.'
    }, 'snakesladders_dice:roll:response');
    return true;
  }
  return false;
}

async function handleDiceRollProcess(socket, diceData, user_id, match = null) {
  return await tryProcessDiceRoll(socket, processDiceRoll, {
    game_id: diceData.game_id,
    contest_id: diceData.contest_id,
    session_token: diceData.session_token,
    device_id: diceData.device_id,
    jwt_token: diceData.jwt_token
  }, user_id, match);
}

async function scoreDiceRollAndUpdateResponse(response, match, user_id) {
  try {
    const consecutiveSixKey = getConsecutiveSixKey(match, user_id);
    const consecutiveSixes = match[consecutiveSixKey] || 0;
    
    const gameContext = {
      isFirstSix: false, 
      consecutiveSixes: consecutiveSixes, 
      turnCount: match.turnCount || 1,
      gameType: 'snakes_ladders'
    };

    const matchPairId = match.match_pair_id || response.game_id;
    const scoreResult = await scoreDiceRoll(user_id, response.dice_number, matchPairId, gameContext);

    if (scoreResult.points > 0) {
      if (match.user1_id === user_id) {
        match.user1_score = (parseInt(match.user1_score) || 0) + scoreResult.points;
      } else if (match.user2_id === user_id) {
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

async function notifyPlayers(socket, io, game_id, match, response, user_id) {
  try {
    response.turn = match.turn;
    response.game_type = 'snakes_ladders';
    response.user1_pieces = match.user1_pieces || [];
    response.user2_pieces = match.user2_pieces || [];
    
    const diceNumber = response.dice_number;
    const getsAnotherTurn = diceNumber === 6;
    response.gets_another_turn = getsAnotherTurn;
    
    if (getsAnotherTurn) {
      response.message = `You rolled a 6! You get another turn!`;
    }
    
    // Always send response to user first
    socket.emit('snakesladders_dice:roll:response', response);
    
    // Then notify opponent (this can fail without affecting user response)
    try {
      const opponentSocketId = await findActiveOpponentSocketId(io, game_id, user_id, 'snakesladders');
      if (opponentSocketId) {
        await broadcastDiceRollToOpponent(io, opponentSocketId, response);
      }
    } catch (opponentErr) {
      // Log but don't throw - user response already sent
    }
  } catch (err) {
    // If socket.emit fails, re-throw to be caught by caller
    throw err;
  }
}

module.exports = { registerDiceRollHandler };
