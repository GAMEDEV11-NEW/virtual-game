const { redis: redisClient } = require("../../utils/redis");
const {
  emitStandardError,
  validateRequiredFields,
  safeParseRedisData,
} = require("../../utils/gameUtils");
const { applyShot } = require("../../helpers/watersort/shootLogic");
const withAuth = require("../../middleware/withAuth");
const { SOCKET_EVENT } = require("./enums");
const {
  processWinnerDeclaration,
} = require("../../services/watersort/windeclearService");
const { findActiveOpponentSocketId } = require("../../helpers/common/gameHelpers");
const CONFIG = require("../../config/watersortConfig");
const { REDIS_KEYS, GAME_STATUS } = require("../../constants");


function countCompletedHolders(holders) {
  if (!holders || typeof holders !== "object") {
    return 0;
  }

  const holderKeys = Object.keys(holders);
  let completedCount = 0;

  for (const key of holderKeys) {
    const holder = holders[key];

    if (Array.isArray(holder) && holder.length === 4) {
      const firstColor = holder[0];
      const allSameColor = holder.every((color) => color === firstColor);
      if (allSameColor) {
        completedCount++;
      }
    }
  }

  return completedCount;
}

function getRequiredHoldersForStage(holders) {
  if (!holders || typeof holders !== "object") {
    return 4; // Default 4 holders for a stage
  }

  const nonEmptyHolders = Object.keys(holders).filter((key) => Array.isArray(holders[key]) && holders[key].length > 0);
  const colors = new Set();
  for (const key of nonEmptyHolders) {
    const holder = holders[key];
    if (Array.isArray(holder) && holder.length > 0) {
      holder.forEach(color => colors.add(color));
    }
  }

  return colors.size > 0 ? colors.size : 4;
}


function isWaterSortCompleted(holders) {
  if (!holders || typeof holders !== "object") {
    return false;
  }

  const holderKeys = Object.keys(holders);

  if (holderKeys.length === 0) {
    return false;
  }

  for (const key of holderKeys) {
    const holder = holders[key];

    if (!Array.isArray(holder) || holder.length === 0) {
      continue;
    }

    if (holder.length === 4) {
      const firstColor = holder[0];
      const allSameColor = holder.every((color) => color === firstColor);
      if (!allSameColor) {
        return false;
      }
    } else {
      return false;
    }
  }

  const completeHolders = holderKeys.filter((key) => {
    const holder = holders[key];
    return (
      Array.isArray(holder) &&
      holder.length === 4 &&
      holder.every((color) => color === holder[0])
    );
  });

  const nonEmptyHolders = holderKeys.filter((key) => {
    const holder = holders[key];
    return Array.isArray(holder) && holder.length > 0;
  });

  const result =
    nonEmptyHolders.length > 0 &&
    completeHolders.length === nonEmptyHolders.length;

  return result;
}

async function registerShootHandler(io, socket) {
  socket.on(SOCKET_EVENT.SHOOT, async (event) => {
    try {
      await withAuth(
        socket,
        event,
        SOCKET_EVENT.SHOOT_RESPONSE,
        async (user, data) => {
          const { game_id, shot } = data || {};
          const { user_id } = user;
          if (
            !validateRequiredFields(
              socket,
              data,
              ["game_id", "shot"],
              SOCKET_EVENT.SHOOT_RESPONSE
            )
          ) {
            return;
          }

          const matchKey = REDIS_KEYS.WATERSORT_MATCH(game_id);
          const raw = await redisClient.get(matchKey);
          if (!raw) {
            emitStandardError(socket, {
              code: "not_found",
              type: "data",
              field: "game_id",
              message: "No match found",
              event: SOCKET_EVENT.SHOOT_RESPONSE,
            });
            return;
          }
          
          const match = safeParseRedisData(raw);
          if (!match) {
            emitStandardError(socket, {
              code: 'parse_error',
              type: 'data',
              field: 'game_id',
              message: 'Failed to parse game data',
              event: SOCKET_EVENT.SHOOT_RESPONSE,
            });
            return;
          }
          if (!match.moveHistory) match.moveHistory = [];

          if (match.game_status === "completed") {
            emitStandardError(socket, {
              code: "game_completed",
              type: "game",
              message: "Game already completed",
              event: SOCKET_EVENT.SHOOT_RESPONSE,
            });
            return;
          }

          let shotData = shot;
          if (typeof shot === "string") {
            try {
              shotData = JSON.parse(shot);
            } catch (err) {
              shotData = shot;
            }
          }

          const applyResult = applyShot(match, user_id, shot);
          const currentTime = new Date().toISOString();
          match.updated_at = currentTime;

          if (match.user1_id === user_id) {
            match.user1_time = currentTime;
          } else {
            match.user2_time = currentTime;
          }

          const moveData = {
            user_id: user_id,
            shot: shot,
            holders: shotData.holders || {},
            timestamp: currentTime,
            move_number: match.moveHistory.length + 1,
            effects: applyResult.effects || {},
          };
          match.moveHistory.push(moveData);

          if (!match.scores) {
            match.scores = { [match.user1_id]: 0, [match.user2_id]: 0 };
          }
          if (!match.completed_holders) {
            match.completed_holders = { [match.user1_id]: 0, [match.user2_id]: 0 };
          }
          if (typeof match.user1_score === 'undefined') {
            match.user1_score = 0;
          }
          if (typeof match.user2_score === 'undefined') {
            match.user2_score = 0;
          }
          if (typeof match.user1_current_stage === 'undefined') {
            match.user1_current_stage = 1;
          }
          if (typeof match.user2_current_stage === 'undefined') {
            match.user2_current_stage = 1;
          }
          if (typeof match.user1_stages_completed === 'undefined') {
            match.user1_stages_completed = 0;
          }
          if (typeof match.user2_stages_completed === 'undefined') {
            match.user2_stages_completed = 0;
          }

          const completedHolders = countCompletedHolders(shotData.holders);
          const previousCompleted = match.completed_holders[user_id] || 0;
          let pointsEarned = 0;
          if (completedHolders > previousCompleted) {
            const newCompleted = completedHolders - previousCompleted;
            pointsEarned = newCompleted * CONFIG.SCORE_PER_TARGET;
            match.scores[user_id] = (match.scores[user_id] || 0) + pointsEarned;
            match.completed_holders[user_id] = completedHolders;

            if (user_id === match.user1_id) {
              match.user1_score = match.scores[user_id];
            } else {
              match.user2_score = match.scores[user_id];
            }
          }

          const isCompleted = isWaterSortCompleted(shotData.holders);

          const requiredHolders = getRequiredHoldersForStage(shotData.holders);
          const stagesCompleted = user_id === match.user1_id ? match.user1_stages_completed : match.user2_stages_completed;
          if (isCompleted && completedHolders >= requiredHolders) {
            match.scores[user_id] = (match.scores[user_id] || 0) + 10;

            if (user_id === match.user1_id) {
              match.user1_score = match.scores[user_id];
              match.user1_current_stage += 1;
              match.user1_stages_completed += 1;
            } else {
              match.user2_score = match.scores[user_id];
              match.user2_current_stage += 1;
              match.user2_stages_completed += 1;
            }
            match.completed_holders[user_id] = 0;
          }

          const opponentUserId =
            match.user1_id === user_id ? match.user2_id : match.user1_id;

          let winnerId = null;
          let gameEndReason = null;
          const MAX_STAGES = 5;

          const userStagesCompleted = user_id === match.user1_id ? match.user1_stages_completed : match.user2_stages_completed;
          const opponentStagesCompleted = user_id === match.user1_id ? match.user2_stages_completed : match.user1_stages_completed;

          if (userStagesCompleted >= MAX_STAGES || opponentStagesCompleted >= MAX_STAGES) {
            if (userStagesCompleted >= MAX_STAGES) {
              winnerId = user_id;
              gameEndReason = "completed_all_5_stages_first";
            } else if (opponentStagesCompleted >= MAX_STAGES) {
              winnerId = opponentUserId;
              gameEndReason = "opponent_completed_all_5_stages_first";
            }
          }

          if (winnerId) {
            const gameDetails = {
              winner_score: winnerId === match.user1_id ? (match.user1_score || 0) : (match.user2_score || 0),
              loser_score: winnerId === match.user1_id ? (match.user2_score || 0) : (match.user1_score || 0),
              total_moves: match.moveHistory ? match.moveHistory.length : 0,
              game_duration: Math.floor(
                (new Date(currentTime) - new Date(match.start_time)) / 1000
              ),
              level_no: match.level_no || 0,
              move_count: match.moveHistory ? match.moveHistory.length : 0,
            };



            const winnerResult = await processWinnerDeclaration(
              game_id,
              winnerId, // winner (based on highest score)
              winnerId === user_id ? opponentUserId : user_id, // loser
              match.league_id, // contest_id - you can modify this as needed 
              gameEndReason,
              gameDetails
            );

            if (winnerResult.success) {
              match.status = "completed";
              match.winner = winnerId;
              match.completed_at = currentTime;
              match.game_end_reason = gameEndReason;

              try {
                socket.emit("stop:timer_updates_watersort", {
                  status: "game_completed",
                  message: "Game completed - timer updates stopped",
                  game_id: game_id,
                  game_status: "completed",
                  winner: user_id,
                  completed_at: currentTime,
                });

                const opponentSocketId = await findActiveOpponentSocketId(
                  io,
                  game_id,
                  user_id,
                  'watersort'
                );
                if (opponentSocketId) {
                  io.to(opponentSocketId).emit("stop:timer_updates_watersort", {
                    status: "game_completed",
                    message: "Game completed - timer updates stopped",
                    game_id: game_id,
                    game_status: "completed",
                    winner: user_id,
                    completed_at: currentTime,
                  });
                }
              } catch (err) {
              }
              
              // Clear both users' sessions from Redis when game completes
              try {
                const sessionService = require('../../utils/sessionService');
                await sessionService.clearSessionsForMatch(match.user1_id, match.user2_id);
              } catch (err) {}
            } else {
              socket.emit(SOCKET_EVENT.SHOOT_RESPONSE, {
                status: "error",
                message:
                  "Game win detected but failed to process winner declaration. Please try again.",
                error: winnerResult.error,
                game_id: game_id,
                timestamp: new Date().toISOString(),
              });
              return;
            }
          }

          if (match.status !== "completed") {
            await redisClient.set(matchKey, JSON.stringify(match));
          }

          const response = {
            status: "success",
            match,
            effects: applyResult.effects || {},
            move_history: match.moveHistory,
            user1_score: match.user1_score || 0,
            user2_score: match.user2_score || 0,
            user1_current_stage: match.user1_current_stage || 1,
            user2_current_stage: match.user2_current_stage || 1,
            user1_stages_completed: match.user1_stages_completed || 0,
            user2_stages_completed: match.user2_stages_completed || 0,
          };

          if (isCompleted) {
            response.game_won = true;
            response.winner_id = user_id;
            response.game_completed_at = currentTime;
            response.game_end_reason = "puzzle_completed";
            response.completion_message = "Puzzle completed successfully!";
          }

          socket.emit(SOCKET_EVENT.SHOOT_RESPONSE, response);

          try {
            const opponentSocketId = await findActiveOpponentSocketId(
              io,
              game_id,
              user_id,
              'watersort'
            );
            if (opponentSocketId) {
              io.to(opponentSocketId).emit("watersort:opponent:move", response);
              if (isCompleted) {
                io.to(opponentSocketId).emit("watersort:game:completed", {
                  winner: user_id,
                  game_end_reason: "puzzle_completed",
                  completed_at: currentTime,
                });
              }
            }
          } catch (err) {
          }

          try {
            if (match.status === "completed") {
              const chanceKey = `watersort_userchance:${game_id}`;
              await redisClient.del(matchKey);
              await redisClient.del(chanceKey);
            }
          } catch (_) {}
        }
      );
    } catch (err) {
      emitStandardError(socket, {
        code: "internal_error",
        type: "server",
        message: "Failed to process shot",
        event: SOCKET_EVENT.SHOOT_RESPONSE,
      });
    }
  });
}

module.exports = { registerShootHandler };
