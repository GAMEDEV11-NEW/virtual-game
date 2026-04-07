const { processPieceMove, broadcastPieceMoveToOpponent } = require('../../helpers/ludo/pieceMoveHelpers');
const { evaluateMoveAgainstBoard, evaluateKillByMapping } = require('../../helpers/ludo/moveRules');
const { redis: redisClient } = require('../../utils/redis');
const withAuth = require('../../middleware/withAuth');
const { grantHomeReachExtraTurn } = require('../../services/ludo/homeReachService');
const { GAME_CONFIG, ERROR_MESSAGES, ERROR_CODES, ERROR_TYPES } = require('../../config/gameConfig');
const { performKill } = require('../../services/ludo/killService');
const { fetchMatchOrEmitError, validateRequiredFields, emitStandardError, saveMatchState, notifyOpponent, safeParseRedisData } = require('../../utils/gameUtils');
const { createResponseGuarantee } = require('../../utils/responseGuarantee');
const { findActiveOpponentSocketId } = require('../../helpers/common/gameHelpers');
const { REDIS_KEYS, GAME_STATUS } = require('../../constants');
const { timerRegistry, timerEventBus } = require('../../utils/timer');

// ============================================================================
// logHandlerError
// ============================================================================
function logHandlerError(context, error, metadata = {}) {
  if (process.env.PIECE_MOVE_DEBUG === 'true') {
    console.error('[piece:move]', context, {
      message: error?.message || String(error || ''),
      ...metadata
    });
  }
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
// PlayerContext
// ============================================================================
class PlayerContext {
  constructor(match, userID) {
    this.isUser1 = sameId(userID, match.user1_id);
    this.userID = userID;
    this.opponentID = this.isUser1 ? match.user2_id : match.user1_id;
    this.timeKey = this.isUser1 ? 'user1_time' : 'user2_time';
    this.opponentTimeKey = this.isUser1 ? 'user2_time' : 'user1_time';
    this.firstSixKey = this.isUser1 ? 'first_six_rolled_user1' : 'first_six_rolled_user2';
  }
}

// ============================================================================
// isPieceAtHomePosition
// ============================================================================
function isPieceAtHomePosition(position) {
  return GAME_CONFIG.POSITIONS.HOME_VALUES.includes(position);
}

// ============================================================================
// updateMatchTimestamps
// ============================================================================
function updateMatchTimestamps(match) {
  const currentTime = new Date().toISOString();
  return {
    ...match,
    user1_time: currentTime,
    user2_time: currentTime
  };
}

const HOME_POSITION = 57;
const SAFE_SQUARES = [1, 9, 14, 22, 27, 35, 40, 48];

// ============================================================================
// isValidBoardPosition
// ============================================================================
function isValidBoardPosition(value) {
  if (value === undefined || value === null || value === 'initial' || value === 'goal') {
    return true;
  }

  const num = Number(value);
  return Number.isInteger(num) && num >= 0 && num <= HOME_POSITION;
}

// ============================================================================
// isNonEmptyString
// ============================================================================
function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

// ============================================================================
// isExactHomeReach
// ============================================================================
function isExactHomeReach(fromPos, toPos) {
  const from = Number(fromPos);
  const to = Number(toPos);
  return to === HOME_POSITION && from < HOME_POSITION;
}

// ============================================================================
// isOvershootHome
// ============================================================================
function isOvershootHome(fromPos, toPos) {
  return Number(toPos) > HOME_POSITION;
}

// ============================================================================
// validatePieceMovePayload
// ============================================================================
function validatePieceMovePayload(socket, moveData) {
  const requiredFields = [
    'game_id', 'contest_id', 'user_id', 'piece_id',
    'from_pos_last', 'to_pos_last', 'piece_type', 'dice_number'
  ];
  if (!validateRequiredFields(socket, moveData, requiredFields, 'piece:move:response')) {
    return { isValid: false };
  }
  if (!isNonEmptyString(moveData.game_id) || !isNonEmptyString(moveData.user_id) || !isNonEmptyString(moveData.piece_id)) {
    emitStandardError(socket, {
      code: ERROR_CODES.INVALID_VALUE,
      type: ERROR_TYPES.VALIDATION,
      field: 'identifiers',
      message: 'Invalid identifiers provided for game, user, or piece.'
    }, 'piece:move:response');
    return { isValid: false };
  }

  const diceNumber = Number(moveData.dice_number);
  if (!Number.isInteger(diceNumber) || diceNumber < 1 || diceNumber > GAME_CONFIG.DICE.SIX_VALUE) {
    emitStandardError(socket, {
      code: ERROR_CODES.INVALID_VALUE,
      type: ERROR_TYPES.VALIDATION,
      field: 'dice_number',
      message: 'Dice number must be an integer between 1 and 6.'
    }, 'piece:move:response');
    return { isValid: false };
  }

  if (!isValidBoardPosition(moveData.from_pos_last) || !isValidBoardPosition(moveData.to_pos_last)) {
    emitStandardError(socket, {
      code: ERROR_CODES.INVALID_VALUE,
      type: ERROR_TYPES.VALIDATION,
      field: 'piece_position',
      message: 'Piece positions must be between 0 and 57 or one of: initial, goal.'
    }, 'piece:move:response');
    return { isValid: false };
  }

  if (!isNonEmptyString(moveData.piece_type)) {
    emitStandardError(socket, {
      code: ERROR_CODES.INVALID_VALUE,
      type: ERROR_TYPES.VALIDATION,
      field: 'piece_type',
      message: 'Piece type is required.'
    }, 'piece:move:response');
    return { isValid: false };
  }
  return { isValid: true, moveData: { ...moveData, dice_number: diceNumber } };
}

// ============================================================================
// fetchAndValidateMatch
// ============================================================================
async function fetchAndValidateMatch(socket, gameID) {
  const match = await fetchMatchOrEmitError(socket, gameID, redisClient, 'piece:move:response');
  if (!match) {
    return { isValid: false };
  }
  return { isValid: true, match };
}

function validateUserInMatch(socket, match, userID) {
  if (!sameId(userID, match.user1_id) && !sameId(userID, match.user2_id)) {
    emitStandardError(socket, {
      code: ERROR_CODES.INVALID_USER || 'invalid_user',
      type: ERROR_TYPES.DATA || 'data',
      field: 'user_id',
      message: 'User not part of this match'
    }, 'piece:move:response');
    return { isValid: false };
  }
  return { isValid: true };
}

// ============================================================================
// validateUserTurn
// ============================================================================
function validateUserTurn(socket, match, userID) {
  if (!sameId(match.turn, userID)) {
    emitStandardError(socket, {
      code: ERROR_CODES.TURN_EXPIRED,
      type: ERROR_TYPES.GAME,
      message: ERROR_MESSAGES.GAME.NOT_YOUR_TURN
    }, 'piece:move:response');
    return { isValid: false };
  }
  return { isValid: true };
}

// ============================================================================
// validateFirstSixRule
// ============================================================================
function validateFirstSixRule(socket, match, moveData, userID) {
  const playerContext = new PlayerContext(match, userID);
  const isAtHome = isPieceAtHomePosition(moveData.from_pos_last);
  const diceNumber = Number(moveData.dice_number);

  if (isAtHome) {
    if (!match[playerContext.firstSixKey]) {
      emitStandardError(socket, {
        code: ERROR_CODES.FIRST_SIX_REQUIRED,
        type: ERROR_TYPES.GAME,
        message: ERROR_MESSAGES.GAME.FIRST_SIX_REQUIRED
      }, 'piece:move:response');
      return { isValid: false };
    }

    if (diceNumber !== GAME_CONFIG.DICE.SIX_VALUE) {
      emitStandardError(socket, {
        code: ERROR_CODES.ILLEGAL_MOVE,
        type: ERROR_TYPES.GAME,
        message: ERROR_MESSAGES.GAME.ILLEGAL_MOVE
      }, 'piece:move:response');
      return { isValid: false };
    }
  }

  return { isValid: true, diceNumber };
}

// ============================================================================
// processPieceMoveAction
// ============================================================================
async function processPieceMoveAction(moveData, userID) {
  try {
    const moveResponse = await processPieceMove({
      gameID: moveData.game_id,
      userID: userID,
      pieceID: moveData.piece_id,
      fromPos: moveData.from_pos_last,
      toPos: moveData.to_pos_last,
      pieceType: moveData.piece_type,
      capturedPiece: moveData.captured_piece || ''
    });
    return { success: true, moveResponse };
  } catch (processErr) {
    const errorMsg = processErr?.message || 
                     (typeof processErr === 'string' ? processErr : String(processErr)) || 
                     ERROR_MESSAGES.SYSTEM.MOVE_PROCESSING_FAILED;
    return {
      success: false,
      error: errorMsg
    };
  }
}

// ============================================================================
// reloadMatchFromRedis
// ============================================================================
async function reloadMatchFromRedis(gameID) {
  const matchKey = REDIS_KEYS.MATCH(gameID);
  const updatedMatchRaw = await redisClient.get(matchKey);

  return safeParseRedisData(updatedMatchRaw);
}

// ============================================================================
// changeTurnToOpponent
// ============================================================================
function changeTurnToOpponent(match, currentUserID) {
  const playerContext = new PlayerContext(match, currentUserID);

  return {
    ...match,
    turn: playerContext.opponentID
  };
}

// ============================================================================
// handleHomeReachBonus
// ============================================================================
async function handleHomeReachBonus(gameID, userID) {
  const updated = await grantHomeReachExtraTurn(gameID, userID);
  if (updated) {
    return { success: true, match: updateMatchTimestamps(updated) };
  }
  const fallback = await reloadMatchFromRedis(gameID);
  if (fallback) {
    return { success: true, match: updateMatchTimestamps(fallback) };
  }
  return { success: true, match: null };
}

// ============================================================================
// handleNormalTurnLogic
// ============================================================================
async function handleNormalTurnLogic(gameID, originalMatch, currentUserID, diceNumber) {
  const updatedMatch = await reloadMatchFromRedis(gameID);
  const shouldGetExtraTurn = diceNumber === GAME_CONFIG.DICE.SIX_VALUE;

  if (updatedMatch) {
    let finalMatch;
    if (shouldGetExtraTurn) {
      finalMatch = updateMatchTimestamps(updatedMatch);
    } else {
      const matchWithTurnChange = changeTurnToOpponent(updatedMatch, currentUserID);
      finalMatch = updateMatchTimestamps(matchWithTurnChange);
    }

    return finalMatch;
  }

  let finalMatch;
  if (shouldGetExtraTurn) {
    finalMatch = updateMatchTimestamps(originalMatch);
  } else {
    const matchWithTurnChange = changeTurnToOpponent(originalMatch, currentUserID);
    finalMatch = updateMatchTimestamps(matchWithTurnChange);
  }

  return finalMatch;
}

// ============================================================================
// updateGameAndNotify
// ============================================================================
async function updateGameAndNotify(socket, io, gameID, match, moveResponse, userID, responseGuarantee = null) {
  try {
    const latestMatch = await reloadMatchFromRedis(gameID);
    
    const mergedMatch = latestMatch ? {
      ...latestMatch,
      turn: match.turn,
      user1_pieces: match.user1_pieces !== undefined ? match.user1_pieces : latestMatch.user1_pieces,
      user2_pieces: match.user2_pieces !== undefined ? match.user2_pieces : latestMatch.user2_pieces,
      user1_score: match.user1_score !== undefined ? match.user1_score : latestMatch.user1_score,
      user2_score: match.user2_score !== undefined ? match.user2_score : latestMatch.user2_score,
      scores: match.scores || latestMatch.scores,
      turnCount: match.turnCount !== undefined ? match.turnCount : latestMatch.turnCount,
      previousTurn: match.previousTurn !== undefined ? match.previousTurn : latestMatch.previousTurn,
      status: match.status || latestMatch.status,
      winner: match.winner || latestMatch.winner,
      completed_at: match.completed_at || latestMatch.completed_at,
      game_end_reason: match.game_end_reason || latestMatch.game_end_reason,
      user1_time: match.user1_time || latestMatch.user1_time,
      user2_time: match.user2_time || latestMatch.user2_time,
      updated_at: new Date().toISOString(),
    } : match;
    
    await saveMatchState(redisClient, gameID, mergedMatch);
    
    const matchForNotify = mergedMatch;
    const normalizedMove = {
      ...moveResponse,
      kill_details: (moveResponse && moveResponse.kill_details) ? moveResponse.kill_details : [],
    };
    const userResponse = {
      ...normalizedMove,
      turn: matchForNotify.turn,
      timestamp: new Date().toISOString(),
      user1_score: parseInt(matchForNotify.user1_score) || 0,
      user2_score: parseInt(matchForNotify.user2_score) || 0,
      user1_pieces: matchForNotify.user1_pieces || [],
      user2_pieces: matchForNotify.user2_pieces || [],
    };
    
    // Use response guarantee if provided, otherwise direct emit
    if (responseGuarantee) {
      responseGuarantee.sendResponse(userResponse);
    } else {
      socket.emit('piece:move:response', userResponse);
    }
    
    const playerContext = new PlayerContext(matchForNotify, userID);
    await notifyOpponent(
      io,
      gameID,
      userID,
      playerContext.opponentID,
      'opponent:move:update',
      {
        ...normalizedMove,
        turn: matchForNotify.turn,
        user1_score: parseInt(matchForNotify.user1_score) || 0,
        user2_score: parseInt(matchForNotify.user2_score) || 0,
        user1_pieces: matchForNotify.user1_pieces || [],
        user2_pieces: matchForNotify.user2_pieces || [],
      },
      broadcastPieceMoveToOpponent
    );
  } catch (err) {
    logHandlerError('updateGameAndNotify failure', err, { gameID });
    
    // Ensure response is sent even on error
    if (responseGuarantee && !responseGuarantee.isResponseSent()) {
      responseGuarantee.sendError({
        code: 'notification_error',
        type: 'system',
        message: 'Move processed but failed to notify. Please refresh.',
        event: 'piece:move:response'
      });
    }
    
    try {
      await saveMatchState(redisClient, gameID, match);
    } catch (saveErr) {
      logHandlerError('updateGameAndNotify fallback save failed', saveErr, { gameID });
    }
  }
}

// ============================================================================
// registerPieceMoveHandler
// ============================================================================
function registerPieceMoveHandler(io, socket) {
  socket.removeAllListeners('piece:move');
  socket.on('piece:move', async (event) => {
    // Create response guarantee to ensure user always gets a response
    const responseGuarantee = createResponseGuarantee(socket, 'piece:move:response', 10000);
    
    try {
      await withAuth(socket, event, 'piece:move:response', async (user, moveData) => {
        const payloadValidation = validatePieceMovePayload(socket, moveData);
        if (!payloadValidation.isValid) {
          responseGuarantee.markAsSent(); // Error already sent by validatePieceMovePayload
          return;
        }
      const { moveData: validatedMoveData } = payloadValidation;
      const currentUserId = normalizeIdValue(user.user_id);
      
      const gameState = await fetchAndValidateMatch(socket, validatedMoveData.game_id);
      if (!gameState.isValid) {
        responseGuarantee.markAsSent(); // Error already sent by fetchAndValidateMatch
        return;
      }
      const { match } = gameState;
      
      if (!match.turnCount) {
        match.turnCount = {
          [match.user1_id]: 0,
          [match.user2_id]: 0
        };
      }

      if (!match.previousTurn || !sameId(match.previousTurn, user.user_id)) {
        match.turnCount[user.user_id] = (match.turnCount[user.user_id] || 0) + 1;
      }
      match.previousTurn = user.user_id;
      
      const membershipValidation = validateUserInMatch(socket, match, user.user_id);
      if (!membershipValidation.isValid) {
        responseGuarantee.markAsSent();
        return;
      }

      if (match.status === GAME_STATUS.COMPLETED) {
        emitStandardError(socket, {
          code: ERROR_CODES.GAME_ALREADY_COMPLETED,
          type: ERROR_TYPES.GAME,
          field: 'game_status',
          message: 'This game is already completed. No more moves allowed.'
        }, 'piece:move:response');
        responseGuarantee.markAsSent();
        return;
      }
      
      const turnValidation = validateUserTurn(socket, match, user.user_id);
      if (!turnValidation.isValid) {
        responseGuarantee.markAsSent(); // Error already sent by validateUserTurn
        return;
      }
      

      const sixRuleValidation = validateFirstSixRule(socket, match, validatedMoveData, user.user_id);
      if (!sixRuleValidation.isValid) {
        responseGuarantee.markAsSent(); // Error already sent by validateFirstSixRule
        return;
      }
      

      const fromPos = validatedMoveData.from_pos_last;
      const toPos = validatedMoveData.to_pos_last;
      if (isOvershootHome(fromPos, toPos)) {
        emitStandardError(socket, {
          code: ERROR_CODES.ILLEGAL_MOVE,
          type: ERROR_TYPES.GAME,
          field: 'to_pos_last',
          message: `Invalid move: You need exactly ${HOME_POSITION - Number(fromPos)} to reach home.`
        }, 'piece:move:response');
        responseGuarantee.markAsSent();
        return;
      }
      const isHomeReach = isExactHomeReach(fromPos, toPos);
      

      const playerPieces = (sameId(user.user_id, match.user1_id)) ? (match.user1_pieces || []) : (match.user2_pieces || []);
      const opponentPieces = (sameId(user.user_id, match.user1_id)) ? (match.user2_pieces || []) : (match.user1_pieces || []);
      const boardEval = evaluateMoveAgainstBoard({
        fromPos,
        toPos,
        playerPieces,
        opponentPieces,
        safeSquares: SAFE_SQUARES,
        homePosition: HOME_POSITION,
        movedPieceId: validatedMoveData.piece_id,
      });

      if (boardEval && boardEval.isValid === false) {
        emitStandardError(socket, {
          code: ERROR_CODES.ILLEGAL_MOVE,
          type: ERROR_TYPES.GAME,
          field: 'to_pos_last',
          message: ERROR_MESSAGES.GAME.ILLEGAL_MOVE
        }, 'piece:move:response');
        responseGuarantee.markAsSent();
        return;
      }
      

      const moveResult = await processPieceMoveAction(validatedMoveData, user.user_id);
      if (!moveResult.success) {
        const errorMessage = moveResult.error || ERROR_MESSAGES.SYSTEM.MOVE_PROCESSING_FAILED;
        emitStandardError(socket, {
          code: ERROR_CODES.VERIFICATION_ERROR,
          type: ERROR_TYPES.SYSTEM,
          field: 'piece_move',
          message: errorMessage,
          status: 'error'
        }, 'piece:move:response');
        responseGuarantee.markAsSent();
        return;
      }
      const { moveResponse } = moveResult;
      // Always include score fields in piece:move response for consistent client parsing.
      moveResponse.score_earned = 0;
      moveResponse.score_reasons = ['no_score_for_this_move'];
      moveResponse.bonus_score = 0;
      moveResponse.total_score = 0;

      const freshMatchAfterMove = await reloadMatchFromRedis(validatedMoveData.game_id);
      const workingMatch = freshMatchAfterMove || match;
      try {
        const isMoverUser1 = sameId(user.user_id, workingMatch.user1_id);
        const arrKey = isMoverUser1 ? 'user1_pieces' : 'user2_pieces';
        const arr = Array.isArray(workingMatch[arrKey]) ? workingMatch[arrKey] : [];
        const idx = arr.findIndex(p => (p.piece_id ?? p.id) === validatedMoveData.piece_id);
        if (idx !== -1) {
          const nowIso = new Date().toISOString();
          if (String(arr[idx].to_pos_last) !== String(validatedMoveData.to_pos_last)) {
            arr[idx].from_pos_last = validatedMoveData.from_pos_last;
            arr[idx].to_pos_last = validatedMoveData.to_pos_last;
            arr[idx].piece_type = validatedMoveData.piece_type;
            arr[idx].updated_at = nowIso;
            workingMatch[arrKey] = arr;
          }
        }
      } catch (err) {
        logHandlerError('failed to sync in-memory piece state', err, {
          gameID: validatedMoveData.game_id,
          userID: user.user_id
        });
      }

      const playerPiecesCurrent = (sameId(user.user_id, workingMatch.user1_id)) ? (workingMatch.user1_pieces || []) : (workingMatch.user2_pieces || []);
      const opponentPiecesCurrent = (sameId(user.user_id, workingMatch.user1_id)) ? (workingMatch.user2_pieces || []) : (workingMatch.user1_pieces || []);
      
      const mappingKill = evaluateKillByMapping(
        toPos,
        opponentPiecesCurrent,
        undefined,
        SAFE_SQUARES ,
        HOME_POSITION
      );
      
      let killOccurred = false;
      if (mappingKill.isKill && mappingKill.killedOpponentPieceIds && mappingKill.killedOpponentPieceIds.length > 0) {
        killOccurred = true;
    
        moveResponse.captured_piece = mappingKill.killedOpponentPieceIds.join(',');
        moveResponse.kill_position = mappingKill.killedOpponentSquare || toPos;
        const killedUserId = (sameId(user.user_id, match.user1_id)) ? match.user2_id : match.user1_id;
        
        const killedPieceIdsMapping = {};
        
        mappingKill.killedOpponentPieceIds.forEach((pieceId, index) => {
          const pieceNumber = index + 1;
          killedPieceIdsMapping[`piece_${pieceNumber}`] = pieceId;
        });

        moveResponse.kill_details = {
          killed_piece_ids: killedPieceIdsMapping,
          killed_piece_id: mappingKill.killedOpponentPieceIds[0],
          killed_user_id: killedUserId,
          killer_user_id: user.user_id,
          landing_square: toPos,
          pieces_killed_count: mappingKill.killedOpponentPieceIds.length,
        };
        
        try {
          const killResult = await performKill(io, {
            gameID: validatedMoveData.game_id,
            killerUserID: user.user_id,
            killedUserID: killedUserId,
            killedPieceID: mappingKill.killedOpponentPieceIds[0],
            killedPieceIDs: mappingKill.killedOpponentPieceIds,
          });
          if (killResult?.success && killResult.match) {
            Object.assign(workingMatch, killResult.match);
          }
        } catch (err) {
          logHandlerError('performKill service failed', err, {
            gameID: validatedMoveData.game_id,
            killer: user.user_id,
            killedUserId
          });
        }
      }

      try {
        const { scorePieceMove } = require('../../services/ludo/scoreService');
        
        const isKill = killOccurred;
        const isHomeReach = isExactHomeReach(fromPos, toPos);
        const isSafeMove = SAFE_SQUARES.includes(Number(toPos));
        
        const scoreResult = await scorePieceMove(
          user.user_id, 
          fromPos, 
          toPos, 
          validatedMoveData.game_id, 
          isKill, 
          isHomeReach, 
          isSafeMove
        );
        
        if (scoreResult.points > 0) {
          if (sameId(workingMatch.user1_id, user.user_id)) {
            workingMatch.user1_score = (parseInt(workingMatch.user1_score) || 0) + scoreResult.points;
          } else if (sameId(workingMatch.user2_id, user.user_id)) {
            workingMatch.user2_score = (parseInt(workingMatch.user2_score) || 0) + scoreResult.points;
          }
          
          if (!workingMatch.scores) {
            workingMatch.scores = {};
          }
          workingMatch.scores[user.user_id] = (parseInt(workingMatch.scores[user.user_id]) || 0) + scoreResult.points;
          
          workingMatch.updated_at = new Date().toISOString();
          
          const currentTotal = sameId(workingMatch.user1_id, currentUserId)
            ? (parseInt(workingMatch.user1_score) || 0)
            : (parseInt(workingMatch.user2_score) || 0);
          moveResponse.score_earned = scoreResult.points;
          moveResponse.score_reasons = Array.isArray(scoreResult.reasons) && scoreResult.reasons.length > 0
            ? scoreResult.reasons
            : ['score_applied'];
          moveResponse.bonus_score = scoreResult.bonusScore || 0;
          moveResponse.total_score = currentTotal;
        } else {
          const currentTotal = sameId(workingMatch.user1_id, currentUserId)
            ? (parseInt(workingMatch.user1_score) || 0)
            : (parseInt(workingMatch.user2_score) || 0);
          moveResponse.score_earned = 0;
          moveResponse.score_reasons = Array.isArray(scoreResult.reasons) && scoreResult.reasons.length > 0
            ? scoreResult.reasons
            : ['no_score_for_this_move'];
          moveResponse.bonus_score = scoreResult.bonusScore || 0;
          moveResponse.total_score = currentTotal;
        }
      } catch (scoreError) {
        logHandlerError('scorePieceMove failed', scoreError, {
          gameID: validatedMoveData.game_id,
          userID: user.user_id
        });
        moveResponse.score_earned = 0;
        moveResponse.score_reasons = ['scoring_failed'];
        moveResponse.bonus_score = 0;
        moveResponse.total_score = sameId(workingMatch.user1_id, currentUserId)
          ? (parseInt(workingMatch.user1_score) || 0)
          : (parseInt(workingMatch.user2_score) || 0);
      }

      const { checkForGameWin } = require('../../utils/gameUtils');
      const { processWinnerDeclaration, cleanupRedisMatchData } = require('../../services/ludo/windeclearService');
      
      let gameWon = false;
      let winnerInfo = null;
      
      try {
        const hasWon = await checkForGameWin(validatedMoveData.game_id, user.user_id, workingMatch);
        
        if (hasWon) {
          gameWon = true;
          const opponentUserId = (sameId(user.user_id, workingMatch.user1_id)) ? workingMatch.user2_id : workingMatch.user1_id;
          
          const winnerScore = (sameId(user.user_id, workingMatch.user1_id)) ? 
            (parseInt(workingMatch.user1_score) || 0) : 
            (parseInt(workingMatch.user2_score) || 0);
          const loserScore = (sameId(user.user_id, workingMatch.user1_id)) ? 
            (parseInt(workingMatch.user2_score) || 0) : 
            (parseInt(workingMatch.user1_score) || 0);
          
          const winnerResult = await processWinnerDeclaration(
            validatedMoveData.game_id,
            user.user_id,
            opponentUserId,
            validatedMoveData.contest_id || 'default',
            'all_pieces_home',
            winnerScore,
            loserScore,
            parseInt(workingMatch.user1_score) || 0,
            parseInt(workingMatch.user2_score) || 0
          );
          
          if (winnerResult.success) {
            winnerInfo = winnerResult;
            
            workingMatch.status = GAME_STATUS.COMPLETED;
            workingMatch.winner = user.user_id;
            workingMatch.completed_at = winnerResult.timestamp;
            workingMatch.game_end_reason = 'all_pieces_home';
            
            moveResponse.game_won = true;
            moveResponse.winner_id = user.user_id;
            moveResponse.game_completed_at = winnerResult.timestamp;
            moveResponse.game_end_reason = 'all_pieces_home';
            
            try {

              timerRegistry.unregisterTimer(validatedMoveData.game_id);
              

              const gameTimersSet = timerRegistry.getGameTimers(validatedMoveData.game_id);
              

              if (gameTimersSet && gameTimersSet.size > 0) {
                for (const timer of gameTimersSet) {
                  try {
                    timerEventBus.emitTimerStop('ludo', validatedMoveData.game_id, timer.socketId, timer.userId, 'game_completed');
                  } catch (err) {
                    logHandlerError('emit timer stop event failed', err, {
                      gameID: validatedMoveData.game_id,
                      socketId: timer.socketId
                    });
                  }
                }
              }
              

              const allSockets = await io.in(validatedMoveData.game_id).fetchSockets();
              
              allSockets.forEach(socket => {
                try {
                  socket.emit('stop:timer_updates', {
                    status: 'game_completed',
                    message: 'Game completed - timer updates stopped',
                    game_id: validatedMoveData.game_id,
                    game_status: GAME_STATUS.COMPLETED,
                    winner: user.user_id,
                    completed_at: winnerResult.timestamp
                  });
                } catch (err) {
                  logHandlerError('emit stop:timer_updates to room socket failed', err, {
                    gameID: validatedMoveData.game_id
                  });
                }
              });
              

              const user1SocketId = await findActiveOpponentSocketId(io, validatedMoveData.game_id, workingMatch.user2_id,'ludo');
              const user2SocketId = await findActiveOpponentSocketId(io, validatedMoveData.game_id, workingMatch.user1_id,'ludo');
              
              if (user1SocketId) {
                try {
                  io.to(user1SocketId).emit('stop:timer_updates', {
                    status: 'game_completed',
                    message: 'Game completed - timer updates stopped',
                    game_id: validatedMoveData.game_id,
                    game_status: GAME_STATUS.COMPLETED,
                    winner: user.user_id,
                    completed_at: winnerResult.timestamp
                  });
                } catch (err) {
                  logHandlerError('emit stop:timer_updates to user1 socket failed', err, {
                    gameID: validatedMoveData.game_id,
                    targetUser: workingMatch.user2_id
                  });
                }
              }
              
              if (user2SocketId) {
                try {
                  io.to(user2SocketId).emit('stop:timer_updates', {
                    status: 'game_completed',
                    message: 'Game completed - timer updates stopped',
                    game_id: validatedMoveData.game_id,
                    game_status: GAME_STATUS.COMPLETED,
                    winner: user.user_id,
                    completed_at: winnerResult.timestamp
                  });
                } catch (err) {
                  logHandlerError('emit stop:timer_updates to user2 socket failed', err, {
                    gameID: validatedMoveData.game_id,
                    targetUser: workingMatch.user1_id
                  });
                }
              }
              
            } catch (err) {
              logHandlerError('stop timers broadcast failed', err, {
                gameID: validatedMoveData.game_id
              });
              try {
                if (socket.id) {
                  timerRegistry.unregisterTimer(validatedMoveData.game_id, socket.id);
                  timerEventBus.emitTimerStop('ludo', validatedMoveData.game_id, socket.id, user.user_id, 'game_completed');
                }
                
                socket.emit('stop:timer_updates', {
                  status: 'game_completed',
                  message: 'Game completed - timer updates stopped',
                  game_id: validatedMoveData.game_id,
                  game_status: GAME_STATUS.COMPLETED,
                  winner: user.user_id,
                  completed_at: winnerResult.timestamp
                });
              } catch (fallbackErr) {
                logHandlerError('stop timer emit to current user failed', fallbackErr, {
                  gameID: validatedMoveData.game_id
                });
              }
            }
	          } else {
	            if (!responseGuarantee.isResponseSent()) {
	              responseGuarantee.sendError({
	                code: 'winner_declaration_failed',
	                type: 'system',
	                message: 'Game win detected but failed to process winner declaration. Please try again.',
	                event: 'piece:move:response'
	              });
	            }
	            
	            return;
	          }
        }
      } catch (err) {
        logHandlerError('checkForGameWin threw error', err, {
          gameID: validatedMoveData.game_id,
          userID: user.user_id
        });
      }

      const latestMatchBeforeFinal = await reloadMatchFromRedis(validatedMoveData.game_id);
      const matchWithLatestPieces = latestMatchBeforeFinal ? {
        ...latestMatchBeforeFinal,
        ...workingMatch,
        user1_pieces: workingMatch.user1_pieces || latestMatchBeforeFinal.user1_pieces || [],
        user2_pieces: workingMatch.user2_pieces || latestMatchBeforeFinal.user2_pieces || [],
      } : workingMatch;
      
      let finalMatch;
      
      if (gameWon && winnerInfo) {
        finalMatch = {
          ...matchWithLatestPieces,
          status: GAME_STATUS.COMPLETED,
          winner: user.user_id,
          completed_at: winnerInfo.timestamp,
          game_end_reason: 'all_pieces_home'
        };
        

        try {
          await saveMatchState(redisClient, validatedMoveData.game_id, finalMatch);
          
          const verifyMatch = await redisClient.get(REDIS_KEYS.MATCH(validatedMoveData.game_id));
          if (verifyMatch) {
            const parsedMatch = safeParseRedisData(verifyMatch);
            if (parsedMatch) {
              if (parsedMatch.status === finalMatch.status && 
                  parsedMatch.winner === finalMatch.winner &&
                  parsedMatch.completed_at === finalMatch.completed_at &&
                  parsedMatch.game_end_reason === finalMatch.game_end_reason) {
              } else {
                logHandlerError('final match verification mismatch after win save', new Error('mismatch detected'), {
                  gameID: validatedMoveData.game_id,
                  expectedWinner: finalMatch.winner
                });
              }
            }
          } else {
            logHandlerError('final match verification missing data', new Error('verifyMatch missing'), {
              gameID: validatedMoveData.game_id
            });
          }
        } catch (err) {
          logHandlerError('final match verification threw error', err, {
            gameID: validatedMoveData.game_id
          });
        }
	      } else if (gameWon && !winnerInfo) {
	        if (!responseGuarantee.isResponseSent()) {
	          responseGuarantee.sendError({
	            code: 'winner_info_missing',
	            type: 'system',
	            message: 'Game win detected but winner information is missing. Please try again.',
	            event: 'piece:move:response'
	          });
	        }
	        
	        return;
	      } else if (isHomeReach) {
        const homeReachResult = await handleHomeReachBonus(
          validatedMoveData.game_id,
          user.user_id
        );
        if (!homeReachResult.success) return;
        finalMatch = homeReachResult.match;
      } else {
        if (killOccurred) {
          finalMatch = updateMatchTimestamps(matchWithLatestPieces);
        } else {
          finalMatch = await handleNormalTurnLogic(
            validatedMoveData.game_id,
            matchWithLatestPieces,
            user.user_id,
            Number(validatedMoveData.dice_number)
          );
        }
      }
      

      if (finalMatch) {
        try {
          await saveMatchState(redisClient, validatedMoveData.game_id, finalMatch);
        } catch (saveErr) {
          logHandlerError('failed to persist finalMatch before notifications', saveErr, {
            gameID: validatedMoveData.game_id
          });
        }
        
        if (gameWon && winnerInfo) {
          try {
            socket.emit('game:won', {
              status: 'success',
              message: '🎉 Congratulations! You have won the game!',
              game_id: validatedMoveData.game_id,
              winner_id: user.user_id,
              completed_at: winnerInfo.timestamp,
              game_end_reason: 'all_pieces_home',
              timestamp: new Date().toISOString()
            });
          } catch (err) {
            logHandlerError('emit game:won failed', err, {
              gameID: validatedMoveData.game_id,
              userID: user.user_id
            });
          }
          
          const opponentUserId = (sameId(user.user_id, finalMatch.user1_id)) ? finalMatch.user2_id : finalMatch.user1_id;
          
        let opponentSocketId = null;
        try {
          opponentSocketId = await findActiveOpponentSocketId(io, validatedMoveData.game_id, user.user_id,'ludo');
        } catch (err) {
          logHandlerError('failed to fetch opponent socket id', err, {
            gameID: validatedMoveData.game_id,
            userID: user.user_id
          });
        }
          
          if (opponentSocketId) {
            try {
              io.to(opponentSocketId).emit('game:lost', {
                status: 'info',
                message: '😔 Game Over! Your opponent has won the game.',
                game_id: validatedMoveData.game_id,
                winner_id: user.user_id,
                loser_id: opponentUserId,
                completed_at: winnerInfo.timestamp,
                game_end_reason: 'all_pieces_home',
                timestamp: new Date().toISOString()
              });
            } catch (err) {
              logHandlerError('emit game:lost to opponent failed', err, {
                gameID: validatedMoveData.game_id,
                opponentUserId
              });
            }
          }
          
          if (!opponentSocketId) {
            try {
              io.in(validatedMoveData.game_id).emit('game:lost', {
                status: 'info',
                message: '😔 Game Over! Your opponent has won the game.',
                game_id: validatedMoveData.game_id,
                winner_id: user.user_id,
                loser_id: opponentUserId,
                completed_at: winnerInfo.timestamp,
                game_end_reason: 'all_pieces_home',
                timestamp: new Date().toISOString()
              });
            } catch (err) {
              logHandlerError('broadcast game:lost to room failed', err, {
                gameID: validatedMoveData.game_id
              });
            }
          }
          
          try {
            await updateGameAndNotify(socket, io, validatedMoveData.game_id, finalMatch, moveResponse, user.user_id, responseGuarantee);
          } catch (err) {
            logHandlerError('updateGameAndNotify failed during win flow', err, {
              gameID: validatedMoveData.game_id
            });
            if (!responseGuarantee.isResponseSent()) {
              responseGuarantee.sendError({
                code: 'notification_error',
                type: 'system',
                message: 'Game won but failed to send notification. Please refresh.',
                event: 'piece:move:response'
              });
            }
          }
          
          try {
            await cleanupRedisMatchData(validatedMoveData.game_id, finalMatch);
          } catch (err) {
            logHandlerError('cleanupRedisMatchData failed', err, {
              gameID: validatedMoveData.game_id
            });
          }
          
          // Clear both users' sessions from Redis when game completes
          try {
            const sessionService = require('../../utils/sessionService');
            await sessionService.clearSessionsForMatch(workingMatch.user1_id, workingMatch.user2_id);
          } catch (err) {
            logHandlerError('clearSessionsForMatch failed', err, {
              gameID: validatedMoveData.game_id
            });
          }

          try {
            const finalVerifyMatch = await redisClient.get(REDIS_KEYS.MATCH(validatedMoveData.game_id));
            if (finalVerifyMatch) {
              const parsedFinalMatch = safeParseRedisData(finalVerifyMatch);
              if (parsedFinalMatch && parsedFinalMatch.status !== 'completed') {
                
                parsedFinalMatch.status = 'completed';
                parsedFinalMatch.winner = user.user_id;
                parsedFinalMatch.completed_at = winnerInfo.timestamp;
                parsedFinalMatch.game_end_reason = 'all_pieces_home';
                
                await redisClient.set(REDIS_KEYS.MATCH(validatedMoveData.game_id), JSON.stringify(parsedFinalMatch));
              } else if (!parsedFinalMatch) {
                logHandlerError('final redis verification parse returned null', new Error('parse failure'), {
                  gameID: validatedMoveData.game_id
                });
              }
            }
          } catch (err) {
            logHandlerError('final redis verification failed', err, {
              gameID: validatedMoveData.game_id
            });
          }
        } else {
          try {
            await updateGameAndNotify(socket, io, validatedMoveData.game_id, finalMatch, moveResponse, user.user_id, responseGuarantee);
          } catch (err) {
            logHandlerError('updateGameAndNotify failed during normal flow', err, {
              gameID: validatedMoveData.game_id
            });
            if (!responseGuarantee.isResponseSent()) {
              responseGuarantee.sendError({
                code: 'notification_error',
                type: 'system',
                message: 'Move processed but failed to send notification. Please refresh.',
                event: 'piece:move:response'
              });
            }
          }
        }
      } else {
        try {
          const refreshed = await fetchAndValidateMatch(socket, validatedMoveData.game_id);
          if (refreshed?.isValid) {
            await updateGameAndNotify(socket, io, validatedMoveData.game_id, refreshed.match, moveResponse, user.user_id, responseGuarantee);
          } else {
            logHandlerError('fetchAndValidateMatch during fallback returned invalid', new Error('invalid match'), {
              gameID: validatedMoveData.game_id
            });
            if (!responseGuarantee.isResponseSent()) {
              responseGuarantee.sendError({
                code: 'state_error',
                type: 'system',
                message: 'Failed to retrieve game state. Please try again.',
                event: 'piece:move:response'
              });
            }
          }
        } catch (err) {
          logHandlerError('fallback refresh/updateGameAndNotify failed', err, {
            gameID: validatedMoveData.game_id
          });
          if (!responseGuarantee.isResponseSent()) {
            responseGuarantee.sendError({
              code: 'fallback_error',
              type: 'system',
              message: 'Move processing failed. Please try again.',
              event: 'piece:move:response'
            });
          }
        }
      }
      });
    } catch (err) {
      // Top-level error handler
      if (!responseGuarantee.isResponseSent()) {
        responseGuarantee.sendError({
          code: 'handler_error',
          type: 'system',
          message: err.message || 'Failed to handle piece move',
          event: 'piece:move:response'
        });
      }
    } finally {
      responseGuarantee.cleanup();
    }
  });
}

module.exports = { registerPieceMoveHandler }; 
