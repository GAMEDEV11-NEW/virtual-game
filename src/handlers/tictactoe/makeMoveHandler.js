const { redis: redisClient } = require("../../utils/redis");
const { emitStandardError, safeParseRedisData } = require("../../utils/gameUtils");
const { findActiveOpponentSocketId } = require("../../helpers/common/gameHelpers");
const withAuth = require("../../middleware/withAuth");
const { SOCKET_EVENT } = require("./enums");
const {
  processWinnerDeclaration,
} = require("../../services/tictactoe/windeclearService");
const { REDIS_KEYS, GAME_STATUS } = require("../../constants");
const { timerRegistry, timerEventBus } = require("../../utils/timer");
const { createTicTacToeTimerUpdatePayload } = require("../../utils/timerPayloads");

function normalizeCell(cell) {
  if (cell === null || cell === undefined) return null;
  if (cell === 0 || cell === "0" || cell === "") return null;
  if (cell === "x") return "X";
  if (cell === "o") return "O";
  return cell;
}

function normalizeBoard(board) {
  if (!Array.isArray(board)) return Array(9).fill(null);
  return board.map(normalizeCell);
}

function checkWinner(board) {
  const lines = [
    [0, 1, 2],
    [3, 4, 5],
    [6, 7, 8],
    [0, 3, 6],
    [1, 4, 7],
    [2, 5, 8],
    [0, 4, 8],
    [2, 4, 6],
  ];

  for (let line of lines) {
    const [a, b, c] = line;
    if (board[a] && board[a] === board[b] && board[a] === board[c]) {
      return board[a];
    }
  }
  return null;
}

function countNullPositions(board) {
  return board.filter((cell) => cell === null).length;
}

function removeOldestMove(match) {
  if (!match.moveHistory || match.moveHistory.length === 0) return null;

  const oldestMove = match.moveHistory.shift();
  match.board[oldestMove.position] = null;
  return oldestMove.position;
}

async function registerMakeMoveHandler(io, socket) {
  socket.on(SOCKET_EVENT.MAKE_MOVE, async (event) => {
    try {
      await withAuth(
        socket,
        event,
        SOCKET_EVENT.MAKE_MOVE_RESPONSE,
        async (user, moveData) => {

          if (
            !moveData.game_id ||
            moveData.position === undefined ||
            moveData.position === null
          ) {
            emitStandardError(socket, {
              code: "missing_field",
              type: "validation",
              message: "game_id and position are required",
              event: SOCKET_EVENT.MAKE_MOVE_RESPONSE,
            });
            return;
          }

          if (
            typeof moveData.position !== "number" ||
            moveData.position < 0 ||
            moveData.position > 8
          ) {
            emitStandardError(socket, {
              code: "invalid_position",
              type: "validation",
              message: "Position must be a number between 0 and 8",
              event: SOCKET_EVENT.MAKE_MOVE_RESPONSE,
            });
            return;
          }

          const { game_id, position } = moveData;
          const user_id = moveData.user_id || (user && user.user_id);

          const matchKey = REDIS_KEYS.TICTACTOE_MATCH(game_id);
          const matchRaw = await redisClient.get(matchKey);

          if (!matchRaw) {
            emitStandardError(socket, {
              code: "not_found",
              type: "data",
              field: "game_id",
              message: "No match found",
              event: SOCKET_EVENT.MAKE_MOVE_RESPONSE,
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
              event: SOCKET_EVENT.MAKE_MOVE_RESPONSE,
            });
            return;
          }
          if (!match.moveHistory) match.moveHistory = [];
          const playerSymbol = match.user1_id === user_id ? "X" : "O";

          if (match.status === "completed") {
            emitStandardError(socket, {
              code: "game_completed",
              type: "game",
              message: "Game already completed",
              event: SOCKET_EVENT.MAKE_MOVE_RESPONSE,
            });
            return;
          }

          if (match.turn !== user_id) {
            emitStandardError(socket, {
              code: "not_your_turn",
              type: "game",
              message: "Not your turn",
              event: SOCKET_EVENT.MAKE_MOVE_RESPONSE,
            });
            return;
          }

          if (moveData.symbol && moveData.symbol !== playerSymbol) {
            emitStandardError(socket, {
              code: "invalid_symbol",
              type: "game",
              message: `You must use symbol "${playerSymbol}"`,
              event: SOCKET_EVENT.MAKE_MOVE_RESPONSE,
            });
            return;
          }

          const normalizedBefore = normalizeBoard(match.board);

          if (normalizedBefore[position] !== null) {
            emitStandardError(socket, {
              code: "position_taken",
              type: "game",
              message: "Position already taken",
              event: SOCKET_EVENT.MAKE_MOVE_RESPONSE,
            });
            return;
          }

          const currentTime = new Date().toISOString();
          match.updated_at = currentTime;
          match.user1_time = currentTime;
          match.user2_time = currentTime;

          match.board[position] = playerSymbol;
          match.moveHistory.push({ user_id, position, symbol: playerSymbol });

          const normalizedAfter = normalizeBoard(match.board);
          const winner = checkWinner(normalizedAfter);

          if (winner) {
            match.status = "completed";
            match.winner = user_id;
            match.game_end_reason = "player_won";
            match.completed_at = currentTime;

            await redisClient.set(matchKey, JSON.stringify(match));

            try {
              const opponentId =
                match.user1_id === user_id ? match.user2_id : match.user1_id;
              const contestId = match.league_id || "default";

              const winnerScore = 1.0;
              const loserScore = 0.0;
              const user1Score = match.user1_id === user_id ? 1.0 : 0.0;
              const user2Score = match.user2_id === user_id ? 1.0 : 0.0;

              const winnerResult = await processWinnerDeclaration(
                game_id,
                user_id,
                opponentId,
                contestId,
                "player_won",
                winnerScore,
                loserScore,
                user1Score,
                user2Score
              );

              if (winnerResult && winnerResult.success) {
                match.winner_declaration = {
                  success: true,
                  prize_amount: winnerResult.prize_amount,
                  wallet_updated: winnerResult.wallet_updated,
                  declared_at: winnerResult.timestamp,
                };
              } else {
                const errorMsg = winnerResult?.error || 'Unknown error';
                match.winner_declaration = {
                  success: false,
                  error: errorMsg,
                declared_at: winnerResult?.timestamp || new Date().toISOString(),
              };
              
              try {
                const { updateMatchPairToCompleted } = require('../../services/common/baseWindeclearService');
                await updateMatchPairToCompleted(game_id);
              } catch (safeguardErr) {}
            }
            } catch (winnerError) {
              match.winner_declaration = {
                  success: false,
                  error: winnerError.message,
                  declared_at: new Date().toISOString(),
                };
            
            try {
              const { updateMatchPairToCompleted } = require('../../services/common/baseWindeclearService');
              await updateMatchPairToCompleted(game_id);
            } catch (safeguardErr) {}
          }
          
          try {
            const { completeTicTacToeGame } = require('../../cron/timers/tictactoe');
            await completeTicTacToeGame(game_id, redisClient, match);
            
            // Clear both users' sessions from Redis when game completes
            try {
              const sessionService = require('../../utils/sessionService');
              await sessionService.clearSessionsForMatch(match.user1_id, match.user2_id);
            } catch (err) {}
          } catch (cleanupErr) {}
          } else {
            match.turn =
              match.user1_id === user_id ? match.user2_id : match.user1_id;

            if (countNullPositions(normalizedAfter) === 0) {
              const clearedPosition = removeOldestMove(match);
              if (clearedPosition !== null && clearedPosition !== undefined) {
                match.cleared_position = clearedPosition;
              }
            }
          }

          await redisClient.set(matchKey, JSON.stringify(match));

          const emissionBoard = Array.isArray(match.board)
            ? match.board.map((cell) => (cell == null ? 0 : cell))
            : Array(9).fill(0);

          const response = {
            status: "success",
            game_id,
            board: emissionBoard,
            turn: match.turn,
            winner: match.winner,
            game_status: match.status,
            position,
            symbol: playerSymbol,
            timestamp: currentTime,
            updated_at: currentTime,
            user1_time: match.user1_time,
            user2_time: match.user2_time,
            move_history: match.moveHistory,
            winner_declaration: match.winner_declaration || null,
            cleared_position: match.cleared_position !== undefined ? match.cleared_position : null,
          };

          socket.emit(SOCKET_EVENT.MAKE_MOVE_RESPONSE, response);

          const opponentSocketId = await findActiveOpponentSocketId(
            io,
            game_id,
            user_id,
            "tictactoe"
          );

          if (opponentSocketId) {
            io.to(opponentSocketId).emit(SOCKET_EVENT.OPPONENT_MOVE, response);
          }

          if (match.status === "completed" && match.winner) {
            timerRegistry.unregisterTimer(game_id);
            
            timerEventBus.emitTimerStop('tictactoe', game_id, socket.id, user_id, 'game_won');
            if (opponentSocketId) {
              const opponentId = match.user1_id === user_id ? match.user2_id : match.user1_id;
              timerEventBus.emitTimerStop('tictactoe', game_id, opponentSocketId, opponentId, 'game_won');
            }

            const gameStats = {
              total_moves: match.moveHistory ? match.moveHistory.length : 0,
              user1_moves: match.moveHistory ? match.moveHistory.filter(m => m.user_id === match.user1_id).length : 0,
              user2_moves: match.moveHistory ? match.moveHistory.filter(m => m.user_id === match.user2_id).length : 0,
              board_filled_positions: emissionBoard.filter(cell => cell !== 0).length,
              game_duration: match.created_at && match.completed_at ? Math.floor((new Date(match.completed_at) - new Date(match.created_at)) / 1000) : 0,
              moves_per_minute: 0
            };

            const completionPayload = createTicTacToeTimerUpdatePayload(
              match,
              null,
              null,
              0,
              0,
              gameStats,
              'completed'
            );
            completionPayload.status = 'completed';
            completionPayload.message = 'Game completed - timer updates stopped';

            try {
              socket.emit('stop:timer_updates_tictactoe', {
                status: 'game_completed',
                message: 'Game completed - timer updates stopped',
                game_id,
                game_status: GAME_STATUS.COMPLETED,
                winner: match.winner,
                completed_at: match.completed_at || match.updated_at,
                timestamp: new Date().toISOString()
              });
              socket.emit('timer_stopped', {
                status: 'stopped',
                message: 'Timer updates stopped successfully',
                game_id,
                reason: 'game_completed',
                timestamp: new Date().toISOString()
              });
              socket.emit('tictactoe_timer_update', completionPayload);
            } catch (err) {
            }

            if (opponentSocketId) {
              const opponentSocket = io.sockets.sockets.get(opponentSocketId);
              if (opponentSocket && opponentSocket.connected) {
                try {
                  opponentSocket.emit('stop:timer_updates_tictactoe', {
                    status: 'game_completed',
                    message: 'Game completed - timer updates stopped',
                    game_id,
                    game_status: GAME_STATUS.COMPLETED,
                    winner: match.winner,
                    completed_at: match.completed_at || match.updated_at,
                    timestamp: new Date().toISOString()
                  });
                  opponentSocket.emit('timer_stopped', {
                    status: 'stopped',
                    message: 'Timer updates stopped successfully',
                    game_id,
                    reason: 'game_completed',
                    timestamp: new Date().toISOString()
                  });
                  opponentSocket.emit('tictactoe_timer_update', completionPayload);
                } catch (err) {
                }
              }
            }
          }
        }
      );
    } catch (err) {
      emitStandardError(socket, {
        code: "handler_error",
        type: "system",
        message: err.message,
        event: SOCKET_EVENT.MAKE_MOVE_RESPONSE,
      });
    }
  });
}

module.exports = { registerMakeMoveHandler };
