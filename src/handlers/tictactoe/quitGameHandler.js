const { authenticateOpponent } = require("../../utils/authUtils");
const {
  processWinnerDeclaration,
} = require("../../services/tictactoe/windeclearService");
 
const emitError = require("../../utils/emitError");
const validateFields = require("../../utils/validateFields");
const { findActiveOpponentSocketId } = require("../../helpers/common/gameHelpers");
const {
  GAME_END_REASONS,
  REDIS_KEYS: SHARED_REDIS_KEYS
} = require("../../constants");

const { SOCKET_EVENT } = require("./enums");

const QUIT_GAME_EVENTS = {
  REQUEST: SOCKET_EVENT.QUIT_GAME,
  RESPONSE: SOCKET_EVENT.QUIT_GAME_RESPONSE,
  NOTIFICATION: "tictactoe:game:quit:notification",
};

const {
  getAndValidateGameMatch: baseGetAndValidateGameMatch,
  updateGameStateInRedis: baseUpdateGameStateInRedis,
  updateDatabaseRecords: baseUpdateDatabaseRecords,
  notifyOpponent: baseNotifyOpponent,
  sendQuitResponse: baseSendQuitResponse,
  stopTimers: baseStopTimers
} = require('../common/baseHandlers');

const gameConfig = {
  getMatchKey: (gameId) => SHARED_REDIS_KEYS.TICTACTOE_MATCH(gameId),
  emitError: emitError,
  responseEvent: QUIT_GAME_EVENTS.RESPONSE,
  processWinnerDeclaration: processWinnerDeclaration,
  notificationEvent: SOCKET_EVENT.OPPONENT_QUIT,
  timerStopEvent: SOCKET_EVENT.STOP_TIMER_UPDATE,
  formatNotification: (gameData) => ({
    status: "success",
    game_id: gameData.gameId,
    winner: gameData.opponentId,
    game_end_reason: GAME_END_REASONS.OPPONENT_QUIT,
    timestamp: gameData.quitAt,
    completed_at: gameData.quitAt,
    updated_at: gameData.quitAt,
    message: "You won! Your opponent has quit the game",
  }),
  formatResponse: (gameData) => ({
    status: "game_lost",
    game_id: gameData.gameId,
    contest_id: gameData.contestId,
    user_id: gameData.userId,
    winner_id: gameData.opponentId,
    quit_at: gameData.quitAt,
    completed_at: gameData.quitAt,
    game_end_reason: GAME_END_REASONS.OPPONENT_QUIT,
    message: "Game quit successfully. Your opponent won the game.",
  })
};

async function getAndValidateGameMatch(gameId, userId, socket) {
  return baseGetAndValidateGameMatch(gameId, userId, socket, gameConfig);
}

async function updateGameStateInRedis(match, userId, opponentId, gameId, socket) {
  return baseUpdateGameStateInRedis(match, userId, opponentId, gameId, socket, gameConfig);
}

async function updateDatabaseRecords(gameId, opponentId, userId, contestId, match, socket) {
  return baseUpdateDatabaseRecords(gameId, opponentId, userId, contestId, match, socket, gameConfig);
}

function notifyOpponent(io, opponentSocketId, gameData) {
  baseNotifyOpponent(io, opponentSocketId, gameData, gameConfig);
  
  if (opponentSocketId) {
    const opponentSocket = io.sockets.sockets.get(opponentSocketId);
    if (opponentSocket) {
      opponentSocket.emit(SOCKET_EVENT.STOP_TIMER_UPDATE, {
        status: "game_completed",
        message: "Opponent quit - timer updates stopped",
        game_id: gameData.gameId,
        game_status: "completed",
        winner: gameData.opponentId,
        completed_at: gameData.quitAt,
      });
    }
  }
}

function sendQuitResponse(socket, gameData) {
  baseSendQuitResponse(socket, gameData, gameConfig);
}

async function registerQuitGameHandler(io, socket) {
  socket.on(QUIT_GAME_EVENTS.REQUEST, async (data) => {
    try {
      const decrypted = await authenticateOpponent(
        socket,
        data,
        QUIT_GAME_EVENTS.RESPONSE,
        require("../../utils/jwt").decryptUserData
      );
      if (!decrypted) return;

      const requiredFields = ["user_id", "game_id", "contest_id"];
      if (
        !validateFields(
          socket,
          decrypted,
          requiredFields,
          QUIT_GAME_EVENTS.RESPONSE
        )
      ) {
        return;
      }

      const { user_id, game_id, contest_id } = decrypted;

      const match = await getAndValidateGameMatch(game_id, user_id, socket);
      if (!match) return;

      const opponentId =
        match.user1_id === user_id ? match.user2_id : match.user1_id;
      const opponentSocketId = await findActiveOpponentSocketId(
        io,
        game_id,
        user_id,
        "tictactoe"
      );

      const updateSuccess = await updateGameStateInRedis(
        match,
        user_id,
        opponentId,
        game_id,
        socket
      );
      if (!updateSuccess) return;

      const dbUpdateSuccess = await updateDatabaseRecords(
        game_id,
        opponentId,
        user_id,
        contest_id,
        match,
        socket
      );
      if (!dbUpdateSuccess) return;

      const gameData = {
        gameId: game_id,
        contestId: contest_id,
        userId: user_id,
        opponentId: opponentId,
        quitAt: match.quit_at,
      };

      notifyOpponent(io, opponentSocketId, gameData);
      sendQuitResponse(socket, gameData);
      
      baseStopTimers(io, socket, opponentSocketId, game_id, opponentId, match.quit_at, gameConfig);
      
    } catch (error) {
      if (socket.connected) {
        emitError(socket, {
          code: "unexpected_error",
          type: "system",
          field: "quit_game",
          message: "An unexpected error occurred during quit game",
          event: QUIT_GAME_EVENTS.RESPONSE,
        });
      }
    }
  });
}

module.exports = { registerQuitGameHandler };
