const { redis: redisClient } = require('../../utils/redis');
const { emitStandardError, safeParseRedisData } = require('../../utils/gameUtils');
const { processWinnerDeclaration, cleanupRedisMatchData } = require('../../services/snakesladders/windeclearService');
const withAuth = require('../../middleware/withAuth');
const { findActiveOpponentSocketId } = require('../../helpers/common/gameHelpers');
const { REDIS_KEYS, GAME_STATUS } = require('../../constants');
const {
  getPieceById,
  updatePieceById,
  hasUserWon,
  getWinProgress,
  getUserPieceCount,
  fetchAndStoreWinAmount,
  checkSnakeOrLadder
} = require('../../helpers/snakesladders/gameUtils');
const { createSnakesTimerUpdatePayload } = require('../../utils/timerPayloads');

const { SNAKES_LADDERS_CONFIG } = require('../../config/snakesladdersConfig');

function safeEmit(target, event, payload) {
  if (!target || typeof target.emit !== 'function') {
    return;
  }
  try {
    target.emit(event, payload);
  } catch (_) {}
}

function emitToSocketId(io, socketId, event, payload) {
  if (!socketId) {
    return;
  }
  try {
    io.to(socketId).emit(event, payload);
  } catch (_) {}
}

function getUserScores(matchData) {
  try {
    let user1Score = parseInt(matchData.user1_score) || 0;
    let user2Score = parseInt(matchData.user2_score) || 0;

    if (matchData.scores && typeof matchData.scores === 'object') {
      if (matchData.scores[matchData.user1_id] !== undefined) {
        user1Score = parseInt(matchData.scores[matchData.user1_id]) || 0;
      }
      if (matchData.scores[matchData.user2_id] !== undefined) {
        user2Score = parseInt(matchData.scores[matchData.user2_id]) || 0;
      }
    }

    return {
      user1_score: user1Score,
      user2_score: user2Score
    };
  } catch (_) {
    return {
      user1_score: 0,
      user2_score: 0
    };
  }
}

function getGameStats(matchData) {
  try {
    const stats = {
      user1_pieces_home: 0,
      user2_pieces_home: 0,
      user1_pieces_out: 0,
      user2_pieces_out: 0,
      user1_pieces_finished: 0,
      user2_pieces_finished: 0,
      total_turns: 0,
      game_duration: 0
    };

    const winningPosition = SNAKES_LADDERS_CONFIG.TOTAL_SQUARES;

    if (Array.isArray(matchData.user1_pieces)) {
      matchData.user1_pieces.forEach(piece => {
        const pos = Number(piece.position) || 0;
        if (pos === 0) {
          stats.user1_pieces_home++;
        } else if (pos >= winningPosition) {
          stats.user1_pieces_finished++;
        } else {
          stats.user1_pieces_out++;
        }
      });
    }

    if (Array.isArray(matchData.user2_pieces)) {
      matchData.user2_pieces.forEach(piece => {
        const pos = Number(piece.position) || 0;
        if (pos === 0) {
          stats.user2_pieces_home++;
        } else if (pos >= winningPosition) {
          stats.user2_pieces_finished++;
        } else {
          stats.user2_pieces_out++;
        }
      });
    }

    if (matchData.created_at && matchData.updated_at) {
      const created = new Date(matchData.created_at);
      const updated = new Date(matchData.updated_at);
      stats.game_duration = Math.floor((updated - created) / 1000);
    }

    return stats;
  } catch (_) {
    return {
      user1_pieces_home: 0,
      user2_pieces_home: 0,
      user1_pieces_out: 0,
      user2_pieces_out: 0,
      user1_pieces_finished: 0,
      user2_pieces_finished: 0,
      total_turns: 0,
      game_duration: 0
    };
  }
}

function buildCompletionPayload(match) {
  const userScores = getUserScores(match);
  const gameStats = getGameStats(match);
  const payload = createSnakesTimerUpdatePayload(
    match,
    null,
    null,
    0,
    0,
    userScores,
    'completed',
    gameStats
  );

  payload.status = 'completed';
  payload.message = 'Game completed - timer updates stopped';

  if (match.winner) {
    payload.winner = match.winner;
    payload.game_end_reason = match.game_end_reason || 'all_pieces_home';
    payload.completed_at = match.completed_at || new Date().toISOString();
  }

  return payload;
}

function buildWinLoseMessages(match, gameId) {
  const user1Score = parseInt(match.user1_score) || 0;
  const user2Score = parseInt(match.user2_score) || 0;
  const basePayload = {
    game_id: gameId,
    winner_id: match.winner,
    game_end_reason: match.game_end_reason || 'all_pieces_home',
    completed_at: match.completed_at || new Date().toISOString(),
    user1_score: user1Score,
    user2_score: user2Score,
    timestamp: new Date().toISOString()
  };

  const winnerMessage = { ...basePayload, status: 'won' };
  const loserMessage = { ...basePayload, status: 'lost' };

  const winnerDetail = {
    ...winnerMessage,
    message: 'dYZ% Congratulations! You won the game!'
  };

  const loserDetail = {
    ...loserMessage,
    message: 'dY~" Game Over! Your opponent has won the game.'
  };

  return { winnerMessage, loserMessage, winnerDetail, loserDetail };
}

function validateUserTurn(socket, match, user_id) {
  if (match.turn !== user_id) {
    emitStandardError(socket, {
      code: 'not_your_turn',
      type: 'game',
      message: 'It is not your turn to move.',
      event: 'snakesladders_piece_move_response'
    });
    return { isValid: false };
  }
  return { isValid: true };
}

function isValidPosition(position) {
  return position >= 0 && position <= SNAKES_LADDERS_CONFIG.TOTAL_SQUARES;
}

function getUserPosition(match, userId) {
  if (match.user1_id === userId) {
    return match.user1_position || 0;
  } else if (match.user2_id === userId) {
    return match.user2_position || 0;
  }
  return 0;
}

function validateMoveRequest(match, userId, newPosition) {
  if (match.user1_id !== userId && match.user2_id !== userId) {
    return {
      isValid: false,
      error: {
        code: 'invalid_user',
        type: 'validation',
        message: 'User is not part of this match'
      }
    };
  }

  if (match.status !== GAME_STATUS.ACTIVE) {
    return {
      isValid: false,
      error: {
        code: 'game_not_active',
        type: 'game',
        message: 'Game is not active'
      }
    };
  }

  if (!isValidPosition(newPosition)) {
    return {
      isValid: false,
      error: {
        code: 'invalid_position',
        type: 'validation',
        message: 'Invalid position on the board'
      }
    };
  }

  return { isValid: true };
}

async function saveMatchState(gameId, match) {
  try {
    const matchKey = REDIS_KEYS.SNAKES_MATCH(gameId);
    await redisClient.set(matchKey, JSON.stringify(match));
    return true;
  } catch (error) {
    return false;
  }
}

async function notifyOpponentAboutMove(io, match, userId, pieceId, fromPosition, toPosition, snakeOrLadder) {
  try {
    const opponentSocketId = await findActiveOpponentSocketId(io, match.game_id, userId, 'snakesladders');
    if (!opponentSocketId) {
      return;
    }

    const moveData = {
      status: 'success',
      message: 'Opponent moved their piece',
      game_id: match.game_id,
      opponent_id: userId,
      piece_id: pieceId,
      from_position: fromPosition,
      to_position: toPosition,
      snake_or_ladder: snakeOrLadder,
      user1_pieces: match.user1_pieces || [],
      user2_pieces: match.user2_pieces || [],
      timestamp: new Date().toISOString()
    };

    const opponentSocket = io.sockets.sockets.get(opponentSocketId);
    safeEmit(opponentSocket, 'snakesladders_piece_moved_opponent', moveData);
    emitToSocketId(io, opponentSocketId, 'snakesladders_piece_moved_opponent', moveData);
  } catch (_) {}
}

async function sendWinnerDeclarationMessages(io, socket, game_id, match, user_id) {
  if (!match || !match.winner) {
    return;
  }

  const { winnerMessage, loserMessage, winnerDetail, loserDetail } = buildWinLoseMessages(match, game_id);
  const completionPayload = buildCompletionPayload(match);
  const isWinner = user_id === match.winner;
  const playerPayload = isWinner ? winnerMessage : loserMessage;
  const playerDetail = isWinner ? winnerDetail : loserDetail;
  const opponentPayload = isWinner ? loserMessage : winnerMessage;
  const opponentDetail = isWinner ? loserDetail : winnerDetail;

  if (socket) {
    safeEmit(socket, 'game:winner_declared', playerPayload);
    safeEmit(socket, isWinner ? 'game:won' : 'game:lost', playerDetail);
    safeEmit(socket, 'snakesladders_timer_update', completionPayload);
    emitToSocketId(io, socket.id, 'game:winner_declared', playerPayload);
    emitToSocketId(io, socket.id, 'snakesladders_timer_update', completionPayload);
  }

  const opponentSocketId = await findActiveOpponentSocketId(io, game_id, user_id, 'snakesladders');
  if (opponentSocketId) {
    const opponentSocket = io.sockets.sockets.get(opponentSocketId);
    safeEmit(opponentSocket, 'game:winner_declared', opponentPayload);
    safeEmit(opponentSocket, isWinner ? 'game:lost' : 'game:won', opponentDetail);
    safeEmit(opponentSocket, 'snakesladders_timer_update', completionPayload);
    emitToSocketId(io, opponentSocketId, 'game:winner_declared', opponentPayload);
    emitToSocketId(io, opponentSocketId, 'snakesladders_timer_update', completionPayload);
  } else {
    io.in(game_id).emit('game:winner_declared', winnerMessage);
    io.in(game_id).emit('game:winner_declared', loserMessage);
    io.in(game_id).emit('snakesladders_timer_update', completionPayload);
  }

  try {
    const { timerRegistry } = require('../../utils/timer');
    timerRegistry.unregisterTimer(game_id);
  } catch (_) {}
}

function createMoveResponse(match, userId, pieceId, oldPosition, newPosition, snakeOrLadder, diceNumber, scoreDelta = 0) {
  const getsAnotherTurn = diceNumber === 6;
  const winProgress = getWinProgress(match, userId);
  const userPieceCount = getUserPieceCount(match, userId);

  let message = 'Piece moved successfully';
  if (getsAnotherTurn && snakeOrLadder.hasSnakeOrLadder && snakeOrLadder.type === 'ladder') {
    message = `Piece moved successfully! Ladder from ${snakeOrLadder.startPosition} to ${snakeOrLadder.endPosition}! You get another turn for rolling 6!`;
  } else if (getsAnotherTurn) {
    message = 'Piece moved successfully! You get another turn for rolling 6!';
  } else if (snakeOrLadder.hasSnakeOrLadder) {
    message = `Piece moved successfully! ${snakeOrLadder.type === 'ladder' ? 'Ladder' : 'Snake'} from ${snakeOrLadder.startPosition} to ${snakeOrLadder.endPosition}!`;
  }

  return {
    status: 'success',
    message: message,
    game_id: match.game_id,
    user_id: userId,
    game_type: 'snakes_ladders',
    piece_id: pieceId,
    dice_number: parseInt(diceNumber),
    old_position: parseInt(oldPosition),
    new_position: parseInt(newPosition),
    score_delta: parseInt(scoreDelta) || 0,
    user1_score: parseInt(match.user1_score) || 0,
    user2_score: parseInt(match.user2_score) || 0,
    snake_or_ladder: {
      hasSnakeOrLadder: snakeOrLadder.hasSnakeOrLadder,
      newPosition: parseInt(snakeOrLadder.newPosition),
      type: snakeOrLadder.type,
      message: snakeOrLadder.message,
      startPosition: snakeOrLadder.startPosition ? parseInt(snakeOrLadder.startPosition) : null,
      endPosition: snakeOrLadder.endPosition ? parseInt(snakeOrLadder.endPosition) : null
    },
    user1_pieces: match.user1_pieces || [],
    user2_pieces: match.user2_pieces || [],
    has_won: winProgress.hasWon,
    win_progress: winProgress,
    user_piece_count: userPieceCount,
    league_id: match.league_id,
    win_amount: match.win_amount || 0,
    contest_data: match.contest_data || null,
    turn: match.turn,
    gets_another_turn: getsAnotherTurn,
    timestamp: new Date().toISOString()
  };
}

function registerPieceMoveHandler(io, socket) {
  socket.on('snakesladders_piece_move', async (event) => {
    try {
      await withAuth(socket, event, 'snakesladders_piece_move_response', async (user, data) => {
        const {
          game_id,
          user_id,
          piece_id,
          dice_number
        } = user;

        if (!game_id || !user_id || !piece_id || !dice_number) {
          emitStandardError(socket, {
            code: 'missing_required_fields',
            type: 'validation',
            message: 'game_id, user_id, piece_id, and dice_number are required',
            event: 'snakesladders_piece_move_response'
          });
          return;
        }

        const matchKey = REDIS_KEYS.SNAKES_MATCH(game_id);
        const matchRaw = await redisClient.get(matchKey);

        if (!matchRaw) {
          emitStandardError(socket, {
            code: 'match_not_found',
            type: 'game',
            message: 'Match not found',
            event: 'snakesladders_piece_move_response'
          });
          return;
        }

        const match = safeParseRedisData(matchRaw);
        if (!match) {
          emitStandardError(socket, {
            code: 'parse_error',
            type: 'data',
            field: 'game_id',
            message: 'Failed to parse game data',
            event: 'snakesladders_piece_move_response',
          });
          return;
        }

        if (!piece_id) {
          emitStandardError(socket, {
            code: 'missing_piece_id',
            type: 'validation',
            message: 'Piece ID is required',
            event: 'snakesladders_piece_move_response'
          });
          return;
        }

        const turnValidation = validateUserTurn(socket, match, user_id);
        if (!turnValidation.isValid) return;

        const selectedPiece = getPieceById(match, user_id, piece_id);
        if (!selectedPiece) {
          emitStandardError(socket, {
            code: 'invalid_piece',
            type: 'validation',
            message: 'Invalid piece ID or piece not found',
            event: 'snakesladders_piece_move_response'
          });
          return;
        }

        const currentPosition = parseInt(selectedPiece.to_pos_last) || 0;
        if (currentPosition === SNAKES_LADDERS_CONFIG.WINNING_POSITION) {
          emitStandardError(socket, {
            code: 'piece_already_finished',
            type: 'game',
            message: 'This piece has already reached the final destination and cannot be moved',
            event: 'snakesladders_piece_move_response'
          });
          return;
        }

        const oldPosition = parseInt(selectedPiece.to_pos_last) || 0;
        const diceNumber = parseInt(dice_number) || 0;
        const newPosition = oldPosition + diceNumber;

        const validation = validateMoveRequest(match, user_id, newPosition);
        if (!validation.isValid) {
          emitStandardError(socket, validation.error, 'snakesladders_piece_move_response');
          return;
        }

        const snakeOrLadder = checkSnakeOrLadder(newPosition);
        const finalPosition = parseInt(snakeOrLadder.newPosition);

        if (finalPosition < 0 || finalPosition > SNAKES_LADDERS_CONFIG.TOTAL_SQUARES) {
          emitStandardError(socket, {
            code: 'invalid_final_position',
            type: 'game',
            message: `Invalid final position: ${finalPosition}`,
            event: 'snakesladders_piece_move_response'
          });
          return;
        }

        const pieceUpdates = {
          from_pos_last: oldPosition,
          to_pos_last: finalPosition,
          position: finalPosition,
          is_home: finalPosition === 0,
          is_finished: finalPosition === SNAKES_LADDERS_CONFIG.TOTAL_SQUARES,
          updated_at: new Date().toISOString()
        };

        updatePieceById(match, user_id, piece_id, pieceUpdates);

        const { isWinnerDeclared, tryDeclareWinner } = require('../../cron/services/winnerService');
        const winnerAlreadyDeclared = await isWinnerDeclared(game_id);
        
        const userWon = hasUserWon(match, user_id);
        let gameCompleted = false;
        
        if (!winnerAlreadyDeclared) {
          if (userWon) {
            try {
              const { timerRegistry } = require('../../utils/timer');
              timerRegistry.unregisterTimer(game_id);
            } catch (err) {
            }

            match.winner = user_id;
            match.status = GAME_STATUS.COMPLETED;
            match.completed_at = new Date().toISOString();
            match.game_end_reason = 'all_pieces_home';
            gameCompleted = true;

            if (match.league_id) {
              await fetchAndStoreWinAmount(match, match.league_id);
            }

            try {
              const opponentId = user_id === match.user1_id ? match.user2_id : match.user1_id;
              const contestId = match.league_id || 'default';

              const winnerScore = (user_id === match.user1_id) ? (parseInt(match.user1_score) || 0) : (parseInt(match.user2_score) || 0);
              const loserScore = (opponentId === match.user1_id) ? (parseInt(match.user1_score) || 0) : (parseInt(match.user2_score) || 0);
              const user1Score = parseInt(match.user1_score) || 0;
              const user2Score = parseInt(match.user2_score) || 0;

              await tryDeclareWinner(game_id, async () => {
                await processWinnerDeclaration(
                  game_id,
                  user_id,
                  opponentId,
                  contestId,
                  'all_pieces_home',
                  winnerScore,
                  loserScore,
                  user1Score,
                  user2Score
                );
              });
            } catch (winnerError) {
              if (winnerError.message && winnerError.message.includes('already declared')) {
              } else {
              }
            }
          }
        } else {
          if (match.status === GAME_STATUS.COMPLETED || match.winner) {
            gameCompleted = true;
            if (!match.winner && match.status === GAME_STATUS.COMPLETED) {
              if (userWon) {
                match.winner = user_id;
              }
            }
          }
        }

        let moveScoreDelta = 0;
        try {
          const scoring = SNAKES_LADDERS_CONFIG.SCORING || {};
          const base = parseInt(scoring.BASE_POINTS_PER_MOVE) || 0;
          const ladderBonus = parseInt(scoring.LADDER_BONUS_POINTS) || 0;
          const snakePenalty = parseInt(scoring.SNAKE_PENALTY_POINTS) || 0;
          const winBonus = parseInt(scoring.WIN_BONUS_POINTS) || 0;

          let scoreDelta = base;
          if (snakeOrLadder && snakeOrLadder.hasSnakeOrLadder) {
            if (snakeOrLadder.type === 'ladder') {
              scoreDelta += ladderBonus;
            } else if (snakeOrLadder.type === 'snake') {
              scoreDelta = -Math.abs(snakePenalty);
            }
          }
          if (userWon) scoreDelta += winBonus;

          if (!match.scores) match.scores = {};
          if (match.user1_id === user_id) {
            match.user1_score = (parseInt(match.user1_score) || 0) + scoreDelta;
          } else if (match.user2_id === user_id) {
            match.user2_score = (parseInt(match.user2_score) || 0) + scoreDelta;
          }
          match.scores[user_id] = (parseInt(match.scores[user_id]) || 0) + scoreDelta;

          moveScoreDelta = scoreDelta;
        } catch (_) {}

        const opponentId = user_id === match.user1_id ? match.user2_id : match.user1_id;

        const now = new Date().toISOString();
        match.user1_time = now;
        match.user2_time = now;
        match.updated_at = now;

        if (!gameCompleted) {
          if (diceNumber === 6) {
            match.turn = user_id;
          } else {
            match.turn = opponentId;
          }
        }

        const saveSuccess = await saveMatchState(game_id, match);

        if (!saveSuccess) {
          emitStandardError(socket, {
            code: 'save_error',
            type: 'system',
            message: 'Failed to save game state',
            event: 'snakesladders_piece_move_response'
          });
          if (gameCompleted && match.winner) {
            await sendWinnerDeclarationMessages(io, socket, game_id, match, user_id);
          }
          return;
        }

        await notifyOpponentAboutMove(io, match, user_id, piece_id, oldPosition, finalPosition, snakeOrLadder);

        const response = createMoveResponse(match, user_id, piece_id, oldPosition, finalPosition, snakeOrLadder, diceNumber, moveScoreDelta);
        socket.emit('snakesladders_piece_move_response', response);

        const shouldSendWinnerMessage = gameCompleted || userWon || (response.has_won === true) || (match.status === GAME_STATUS.COMPLETED);
        
        if (shouldSendWinnerMessage) {
          if (!match.winner && userWon) {
            match.winner = user_id;
            match.status = GAME_STATUS.COMPLETED;
            match.completed_at = match.completed_at || new Date().toISOString();
            match.game_end_reason = match.game_end_reason || 'all_pieces_home';
          }
          
          if (match.winner) {
            await sendWinnerDeclarationMessages(io, socket, game_id, match, user_id);
          } else if (match.status === GAME_STATUS.COMPLETED) {
            const finalMatchKey = REDIS_KEYS.SNAKES_MATCH(game_id);
            try {
              const finalMatchRaw = await redisClient.get(finalMatchKey);
              if (finalMatchRaw) {
                const finalMatch = safeParseRedisData(finalMatchRaw);
                if (finalMatch && finalMatch.winner) {
                  match.winner = finalMatch.winner;
                  await sendWinnerDeclarationMessages(io, socket, game_id, match, user_id);
                }
              }
            } catch (err) {
            }
          }
        }

        if (match.status === GAME_STATUS.COMPLETED) {
          setTimeout(async () => {
            try {
              const { isWinnerDeclared } = require('../../cron/services/winnerService');
              const stillDeclared = await isWinnerDeclared(game_id);
              if (stillDeclared) {
                await cleanupRedisMatchData(game_id);
                
                // Clear both users' sessions from Redis when game completes
                try {
                  const sessionService = require('../../utils/sessionService');
                  await sessionService.clearSessionsForMatch(match.user1_id, match.user2_id);
                } catch (err) {}
              }
            } catch (err) {
            }
          }, 5000);
        }

      });
    } catch (error) {
      emitStandardError(socket, {
        code: 'piece_move_error',
        type: 'system',
        message: error.message || 'Failed to move piece',
        event: 'snakesladders_piece_move_response'
      });
    }
  });
}

module.exports = {
  registerPieceMoveHandler
};
