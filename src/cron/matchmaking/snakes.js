// ============================================================================
// Imports
// ============================================================================

const cassandra = require('cassandra-driver');
const axios = require('axios');
const { GamePiecesService } = require('../services/piecesService');
const { WinnerDeclarationService } = require('../services/winnerService');
const { RedisService, getRedisService } = require('../../utils/redis');
const { config } = require('../../utils/config');

const SERVER_ID = config.serverId;
const {
  GAME_STATUS,
  REDIS_TTL,
  REDIS_KEYS,
  DB_QUERIES,
  getContestTypeMaxChances,
  getTodayString,
  getCurrentMonth
} = require('../../constants');
const {
  toDate,
  safeJSONParse,
  toFloat,
  getRowValue,
  normalizeUuid,
  sanitizeLeagueIds,
  resolveOpponentLeagueId,
  toInterfaceSlice
} = require('../../utils/dataUtils');

const SELECT_PENDING = DB_QUERIES.SELECT_PENDING;
const INSERT_MATCH_PAIR = DB_QUERIES.INSERT_MATCH_PAIR;
const INSERT_DICE_LOOKUP = DB_QUERIES.INSERT_DICE_LOOKUP;
const UPDATE_PENDING_OPPONENT = DB_QUERIES.UPDATE_PENDING_OPPONENT;
const DELETE_PENDING = DB_QUERIES.DELETE_PENDING;
const DELETE_PENDING_BY_STATUS = DB_QUERIES.DELETE_PENDING_BY_STATUS;
const UPDATE_LEAGUE_JOIN = DB_QUERIES.UPDATE_LEAGUE_JOIN;
const UPDATE_LEAGUE_EXPIRED = DB_QUERIES.UPDATE_LEAGUE_EXPIRED;
const SELECT_LEAGUE_JOIN_EXTRA = DB_QUERIES.SELECT_LEAGUE_JOIN_EXTRA;
const SELECT_USER_DETAILS = DB_QUERIES.SELECT_USER_DETAILS;
const { updateLeagueJoinById, updateLeagueJoinByIdExpired } = require('../../services/ludo/gameService');

// ============================================================================
// Matchmaking constants
// ============================================================================

const MATCHMAKING_CUTOFF_MS = 10_000;
const EXPIRY_WARNING_START_OFFSET_MS = 10_000;
const EXPIRY_WARNING_END_OFFSET_MS = 6_000;

const PIECES_READ_RETRY_DELAY_MS = 200;
const PIECES_READ_MAX_RETRIES = 3;

// ============================================================================
// Small functional helpers (pure / reusable)
// ============================================================================

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const isExpired = (joinedAt, cutoff) => joinedAt < cutoff;

const isInWindow = (joinedAt, start, end) => joinedAt >= start && joinedAt < end;

const canPairUsers = (a, b) => {
  if (!a || !b) return false;
  if (a.userId === b.userId) return false;
  if (a.leagueId !== b.leagueId) return false;
  if (a.gameType !== b.gameType) return false;
  if (a.contestType !== b.contestType) return false;
  // If both users have b_s = true, do not match them
  if (a.b_s === true && b.b_s === true) return false;
  return true;
};

// ============================================================================
// Session Service
// ============================================================================

class SessionService {
  constructor(session) {
    this.session = session;
    this.redis = null;
    this.redisInitialized = false;
    this.sessionConnectionName = 'default';
  }

  async initializeRedis() {
    if (this.redisInitialized) return;
    const hasSessionRedis = config.redis.session.url && config.redis.session.url.trim() !== '';
    const connectionNames = hasSessionRedis ? ['session', 'default'] : ['default'];
    this.redis = new RedisService(connectionNames);
    this.sessionConnectionName = hasSessionRedis ? 'session' : 'default';
    this.redisInitialized = true;
  }

  async close() {
    if (this.redis) {
      await this.redis.close();
      this.redis = null;
      this.redisInitialized = false;
    }
  }

  async ensureSessionForUser(userId) {
    if (!userId) return;
    await this.initializeRedis();

    // Direct lookup by userId
    const sessionKey = `session:${userId}`;
    const existing = await this.redis.get(sessionKey, this.sessionConnectionName);
    if (existing) {
      existing.last_seen = new Date().toISOString();
      await this.redis.set(sessionKey, existing, 0, this.sessionConnectionName);
      return;
    }

    // Not in cache, fetch from database and store
    const sessionRecord = await this.getActiveSession(userId);
    if (sessionRecord) {
      await this.storeSessionInRedis(sessionRecord, userId);
    }
  }

  async ensureSessionsForMatch(user1Id, user2Id) {
    await Promise.all([this.ensureSessionForUser(user1Id), this.ensureSessionForUser(user2Id)]);
  }

  async getActiveSession(userId) {
    if (userId == null) {
      return null;
    }
    const query = `SELECT user_id, device_id, expires_at, fcm_token, is_active, jwt_token, mobile_no, session_token, updated_at FROM sessions WHERE user_id = ?`;
    const result = await this.session.execute(query, [userId], { prepare: true });
    if (result.rowLength === 0) return null;
    const row = result.first();
    if (!row.is_active) return null;
    return row;
  }

  async storeSessionInRedis(row, userId) {
    await this.initializeRedis();
    const now = new Date();
    const expiresAt = row.expires_at ? row.expires_at.toISOString?.() || new Date(row.expires_at).toISOString() : '0001-01-01T00:00:00.000Z';
    const sessionKey = `session:${userId}`;
    const payload = {
      session_token: row.session_token,
      mobile_no: row.mobile_no,
      user_id: userId,
      device_id: row.device_id,
      fcm_token: row.fcm_token,
      jwt_token: row.jwt_token,
      socket_id: '',
      is_active: row.is_active,
      created_at: (row.updated_at?.toISOString?.() || now.toISOString()),
      expires_at: expiresAt,
      user_status: 'existing_user',
      connected_at: '0001-01-01T00:00:00.000Z',
      last_seen: now.toISOString(),
      user_agent: '',
      ip_address: '',
      namespace: ''
    };
    await this.redis.set(sessionKey, payload, 0, this.sessionConnectionName);
  }
}

// ============================================================================
// Snakes & Ladders Matchmaking Service
// ============================================================================

class SnakesMatchmakingService {
  constructor(session) {
    this.session = session;
  }

  getCassandraSession() {
    return this.session;
  }

  _buildPendingUser(row) {
    const userId = getRowValue(row, 'user_id');
    const joinedAt = toDate(getRowValue(row, 'joined_at'));
    if (!userId || !joinedAt) return null;

    const b_s = getRowValue(row, 'b_s');
    const b_sValue = b_s === true || b_s === 'true' || b_s === 1 || b_s === '1' ? true : false;

    return {
      userId,
      leagueId: getRowValue(row, 'league_id'),
      joinedAt,
      id: normalizeUuid(getRowValue(row, 'id')),
      statusId: getRowValue(row, 'status_id'),
      joinDay: getRowValue(row, 'join_day'),
      extraData: getRowValue(row, 'extra_data'),
      gameType: getRowValue(row, 'game_type'),
      contestType: getRowValue(row, 'contest_type'),
      serverId: getRowValue(row, 'server_id') || SERVER_ID,
      b_s: b_sValue
    };
  }

  async _loadPendingUsers(joinDays, leagueIdsArray) {
    const users = [];

    for (const joinDay of joinDays) {
      const result = await this.session.execute(
        SELECT_PENDING,
        [GAME_STATUS.PENDING, joinDay, leagueIdsArray, SERVER_ID],
        { prepare: true }
      );

      for (const row of result.rows) {
        const user = this._buildPendingUser(row);
        if (user) users.push(user);
      }
    }

    return users;
  }

  async processSnakesLaddersMatchmaking(leagueIds) {
    const leagueIdsArray = sanitizeLeagueIds(leagueIds);
    if (leagueIdsArray.length === 0) return;

    const today = new Date();
    const yesterday = new Date(today.getTime() - 24 * 60 * 60 * 1000);
    const joinDays = [getTodayString(today), getTodayString(yesterday)];
    const pendingUsers = await this._loadPendingUsers(joinDays, leagueIdsArray);

    const matchedUsers = new Set();
    const redisService = getRedisService();
    const notifiedUsersKeyPrefix = 'snakes_expiry_notified:';
    const notificationTTL = 15;
    let pendingSlot = null;
    const cutoff = new Date(Date.now() - MATCHMAKING_CUTOFF_MS);
    const expiryWarningStart = new Date(Date.now() - EXPIRY_WARNING_START_OFFSET_MS);
    const expiryWarningEnd = new Date(Date.now() - EXPIRY_WARNING_END_OFFSET_MS);

    const expireSafe = async (user) => {
      if (!user) return;
      try {
        await this.expirePending(user);
      } catch (err) { }
    };

    for (const user of pendingUsers) {
      if (isExpired(user.joinedAt, cutoff)) {
        await expireSafe(user);
        continue;
      }

      if (pendingSlot && isExpired(pendingSlot.joinedAt, cutoff)) {
        await expireSafe(pendingSlot);
        pendingSlot = null;
      }

      await this.maybeSendExpiryWarning(user, expiryWarningStart, expiryWarningEnd, redisService, notifiedUsersKeyPrefix, notificationTTL);

      if (matchedUsers.has(user.userId)) continue;

      if (!pendingSlot) {
        pendingSlot = user;
        continue;
      }

      if (!canPairUsers(pendingSlot, user)) continue;

      try {
        await this.createSnakesMatch(pendingSlot, user);
        matchedUsers.add(pendingSlot.userId);
        matchedUsers.add(user.userId);
      } catch (err) { }

      pendingSlot = null;
    }

    if (!pendingSlot) return;
    if (isExpired(pendingSlot.joinedAt, cutoff)) {
      await expireSafe(pendingSlot);
      return;
    }
    await this.maybeSendExpiryWarning(pendingSlot, expiryWarningStart, expiryWarningEnd, redisService, notifiedUsersKeyPrefix, notificationTTL);
  }

  async createSnakesMatch(user1, user2) {
    if (!user1 || !user2 || !user1.userId || !user2.userId) {
      throw new Error('Invalid user data for match creation');
    }

    const matchPairId = await this.createMatchPairEntry(user1, user2);
    const piecesSvc = new GamePiecesService(this.session);

    await Promise.all([
      piecesSvc.createSnakesLaddersPiecesForMatch(matchPairId, user1.userId, user2.userId),
      this.createDiceRolls(matchPairId, user1.userId, user2.userId)
    ]);

    let user1Pieces, user2Pieces, user1Dice, user2Dice;
    let retries = 0;

    while (retries < PIECES_READ_MAX_RETRIES) {
      [user1Pieces, user2Pieces, user1Dice, user2Dice] = await Promise.all([
        piecesSvc.getUserPieces(matchPairId, user1.userId),
        piecesSvc.getUserPieces(matchPairId, user2.userId),
        piecesSvc.getUserDice(matchPairId, user1.userId),
        piecesSvc.getUserDice(matchPairId, user2.userId)
      ]);

      if (user1Pieces?.length && user2Pieces?.length) break;
      if (retries < PIECES_READ_MAX_RETRIES - 1) {
        await sleep(PIECES_READ_RETRY_DELAY_MS);
      }
      retries++;
    }

    const user1DiceIface = toInterfaceSlice(user1Dice || []);
    const user2DiceIface = toInterfaceSlice(user2Dice || []);
    const user1PiecesIface = toInterfaceSlice(user1Pieces || []);
    const user2PiecesIface = toInterfaceSlice(user2Pieces || []);

    await this.updateUsersAndPending(user1, user2, matchPairId);
    await this.storeSnakesMatch(matchPairId, user1, user2, {
      user1Pieces: user1PiecesIface,
      user2Pieces: user2PiecesIface,
      user1Dice: user1DiceIface,
      user2Dice: user2DiceIface
    });
    await this.ensureSessions(user1.userId, user2.userId);
    return matchPairId;
  }

  async createMatchPairEntry(user1, user2) {
    const matchPairId = cassandra.types.TimeUuid.now().toString();
    const now = new Date();
    const user1PendingId = user1.id || user1.userId;
    const user2PendingId = user2.id || user2.userId;
    await this.session.execute(
      INSERT_MATCH_PAIR,
      [matchPairId, user1PendingId, user2PendingId, user1.userId, user2.userId, GAME_STATUS.ACTIVE, now, now],
      { prepare: true }
    );
    return matchPairId;
  }

  async createDiceRolls(matchPairId, user1Id, user2Id) {
    const now = new Date();
    const [user1DiceId, user2DiceId] = [
      cassandra.types.TimeUuid.now(),
      cassandra.types.TimeUuid.now()
    ];

    await Promise.all([
      this.session.execute(
        INSERT_DICE_LOOKUP,
        [matchPairId, user1Id, user1DiceId, now],
        { prepare: true }
      ),
      this.session.execute(
        INSERT_DICE_LOOKUP,
        [matchPairId, user2Id, user2DiceId, now],
        { prepare: true }
      )
    ]);
  }

  async updateUsersAndPending(user1, user2, matchPairId) {
    let turnId1 = 1;
    let turnId2 = 2;
    if (!(user1.joinedAt < user2.joinedAt)) {
      turnId1 = 2;
      turnId2 = 1;
    }

    await this.updateUserWithOpponent(user1, user2.userId, matchPairId, turnId1, user2.leagueId);
    await this.updateUserWithOpponent(user2, user1.userId, matchPairId, turnId2, user1.leagueId);

    await this.updatePendingOpponent(user1, user2.userId);
    await this.updatePendingOpponent(user2, user1.userId);

    await this.deletePending(user1);
    await this.deletePending(user2);
  }

  async updateUserWithOpponent(user, opponentUserId, matchPairId, turnId, opponentLeagueId) {
    const joinMonth = getCurrentMonth(user.joinedAt);
    const resolvedLeagueId = resolveOpponentLeagueId(opponentLeagueId, user.leagueId);
    await this.session.execute(
      UPDATE_LEAGUE_JOIN,
      [
        opponentUserId,
        resolvedLeagueId,
        matchPairId,
        turnId,
        GAME_STATUS.MATCHED,
        user.userId,
        user.statusId,
        joinMonth,
        user.joinedAt
      ],
      { prepare: true }
    );

    // Also update league_joins_by_id for fast lookups
    if (user.id) {
      try {
        await updateLeagueJoinById(user.id, opponentUserId, GAME_STATUS.MATCHED, {
          matchPairId: matchPairId,
          turnId: turnId,
          opponentLeagueId: resolvedLeagueId,
          statusId: user.statusId
        });
      } catch (err) { }
    }
  }

  async updatePendingOpponent(user, opponentUserId) {
    const serverId = user.serverId || SERVER_ID;
    await this.session.execute(
      UPDATE_PENDING_OPPONENT,
      [opponentUserId, user.statusId, user.joinDay, user.leagueId, serverId, user.joinedAt],
      { prepare: true }
    );
  }

  async deletePending(user) {
    await Promise.all([
      this.session.execute(DELETE_PENDING, [user.statusId, user.joinDay, user.leagueId, user.serverId || SERVER_ID, user.joinedAt], { prepare: true }),
      this.session.execute(DELETE_PENDING_BY_STATUS, [user.userId, user.statusId, user.joinedAt], { prepare: true })
    ]);
  }

  async storeSnakesMatch(matchPairId, user1, user2, { user1Pieces, user2Pieces, user1Dice, user2Dice }) {
    const redisService = getRedisService();
    const startTime = new Date().toISOString();
    const turn = user1.joinedAt > user2.joinedAt ? user2.userId : user1.userId;
    const maxChances = getContestTypeMaxChances(user1.contestType);
    const user1Details = await this.getUserDetails(user1.userId);
    const user2Details = await this.getUserDetails(user2.userId);
    const matchData = {
      game_id: matchPairId,
      user1_id: user1.userId,
      user2_id: user2.userId,
      user1_time: startTime,
      user2_time: startTime,
      turn,
      start_time: startTime,
      status: GAME_STATUS.ACTIVE,
      user1_pieces: user1Pieces,
      user2_pieces: user2Pieces,
      user1_dice: user1Dice,
      user2_dice: user2Dice,
      user1_connection_count: 0,
      user2_connection_count: 0,
      user1_chance: maxChances,
      user2_chance: maxChances,
      user1_score: 0,
      user2_score: 0,
      game_type: user1.gameType,
      contest_type: user1.contestType,
      league_id: user1.leagueId,
      user1_full_name: user1Details.fullName,
      user1_profile_data: user1Details.profileData,
      user2_full_name: user2Details.fullName,
      user2_profile_data: user2Details.profileData
    };
    await redisService.set(REDIS_KEYS.SNAKES_MATCH(matchPairId), matchData, REDIS_TTL.MATCH_SECONDS);
    await redisService.set(
      REDIS_KEYS.SNAKES_USER_CHANCE(matchPairId),
      {
        [user1.userId]: maxChances,
        [user2.userId]: maxChances
      },
      REDIS_TTL.MATCH_SECONDS
    );
  }

  async getUserDetails(userId) {
    if (userId == null) {
      return { fullName: '', profileData: '' };
    }
    const result = await this.session.execute(SELECT_USER_DETAILS, [userId], { prepare: true });
    if (!result || result.rowLength === 0) {
      return { fullName: '', profileData: '' };
    }
    const row = result.first();
    return {
      fullName: getRowValue(row, 'full_name') || '',
      profileData: getRowValue(row, 'profile_data') || ''
    };
  }

  async ensureSessions(user1Id, user2Id) {
    const sessionService = new SessionService(this.session);
    try {
      await sessionService.ensureSessionsForMatch(user1Id, user2Id);
    } finally {
      await sessionService.close();
    }
  }

  async expirePending(user) {
    try {
      await this.processExpiredEntryRefund(user);
    } catch (err) {
      // Error handling
    }
    const joinMonth = getCurrentMonth(user.joinedAt);
    await Promise.all([
      this.session.execute(DELETE_PENDING, [user.statusId, user.joinDay, user.leagueId, user.serverId || SERVER_ID, user.joinedAt], { prepare: true }),
      this.session.execute(DELETE_PENDING_BY_STATUS, [user.userId, user.statusId, user.joinedAt], { prepare: true }),
      this.session.execute(UPDATE_LEAGUE_EXPIRED, [GAME_STATUS.EXPIRED, user.userId, user.statusId, joinMonth, user.joinedAt], { prepare: true })
    ]);

    if (user.id) {
      try {
        await updateLeagueJoinByIdExpired(user.id, GAME_STATUS.EXPIRED, user.statusId);
      } catch (err) {
      }
    }
  }

  async processExpiredEntryRefund(user) {
    const entryFee = await this.getEntryFeeFromLeagueJoins(user);
    if (entryFee <= 0) return;
    const winnerService = new WinnerDeclarationService(this.session);
    await winnerService.processExpiredEntryRefund(user.userId, entryFee, user.joinedAt);
  }

  async getEntryFeeFromLeagueJoins(user) {
    const joinMonth = getCurrentMonth(user.joinedAt);
    const result = await this.session.execute(
      SELECT_LEAGUE_JOIN_EXTRA,
      [user.userId, user.statusId, joinMonth],
      { prepare: true }
    );

    if (result.rows.length === 0) {
      return 0;
    }

    const userEntryId = user.id ? normalizeUuid(user.id) : null;
    let matchedRow = null;

    if (userEntryId) {
      matchedRow = result.rows.find(row => {
        const rowId = normalizeUuid(getRowValue(row, 'id'));
        return rowId === userEntryId;
      });
    }

    if (!matchedRow && user.joinedAt) {
      matchedRow = result.rows.find(row => {
        const rowJoinedAt = getRowValue(row, 'joined_at');
        return rowJoinedAt && rowJoinedAt.getTime && rowJoinedAt.getTime() === user.joinedAt.getTime();
      });
    }

    if (!matchedRow && result.rows.length > 0) {
      matchedRow = result.rows[0];
    }

    if (!matchedRow) {
      return 0;
    }

    const entryFeeColumn = getRowValue(matchedRow, 'entry_fee');
    if (entryFeeColumn !== null && entryFeeColumn !== undefined) {
      const entryFee = toFloat(entryFeeColumn);
      if (entryFee > 0) {
        return entryFee;
      }
    }

    const extraData = getRowValue(matchedRow, 'extra_data');
    const parsed = safeJSONParse(extraData);
    if (parsed && Object.prototype.hasOwnProperty.call(parsed, 'entry_fee')) {
      const entryFee = toFloat(parsed.entry_fee);
      if (entryFee > 0) {
        return entryFee;
      }
    }

    return 0;
  }

  // ============================================================================
  // send expiry warning if user is in warning window
  // ============================================================================
  async maybeSendExpiryWarning(user, expiryWarningStart, expiryWarningEnd, redisService, notifiedUsersKeyPrefix, notificationTTL) {
    // Step 1: Check if user exists and is in warning window
    if (!user) return;
    if (!isInWindow(user.joinedAt, expiryWarningStart, expiryWarningEnd)) return;

    // Step 2: Check if user has already been notified via Redis
    const notifiedKey = `${notifiedUsersKeyPrefix}${user.userId}`;
    try {
      const alreadyNotified = await redisService.get(notifiedKey);
      if (alreadyNotified) return;

      // Step 3: Mark user as notified in Redis
      await redisService.set(notifiedKey, '1', notificationTTL);

      // Step 4: Loop through bots sequentially until one succeeds
      const maxUserId = 1000;
      const apiUrl = 'http://localhost:3001/api/bot/snl/start';
      const contestId = user.leagueId || user.contestType || '9';
      let apiSuccess = false;

      for (let botId = 1; botId <= maxUserId; botId++) {
        try {
          // Step 4a: Get bot user data
          const botQuery = `SELECT user_id, status, base_url, bot_name, redis_db, redis_host, redis_password,
                          redis_port, redis_username, socket_url, sys_user_id, team_name, team_size, user_ip, webhook_url
                          FROM bot_user_ids
                          WHERE user_id = ? AND status = ?`;
          const botResult = await this.session.execute(botQuery, [botId.toString(), false], { prepare: true });
          if (botResult.rowLength === 0) {
            continue; // No bot found for this ID, try next
          }

          const row = botResult.first();
          const sysUserIdString =
            row.sys_user_id && typeof row.sys_user_id === 'object' && row.sys_user_id.toString
              ? row.sys_user_id.toString()
              : String(row.sys_user_id || '');
          const botUserData = {
            user_id: sysUserIdString,
            bot_id: String(row.user_id || ''),
            status: row.status,
            base_url: row.base_url,
            bot_name: row.bot_name,
            redis_db: row.redis_db,
            redis_host: row.redis_host,
            redis_password: row.redis_password,
            redis_port: row.redis_port,
            redis_username: row.redis_username,
            socket_url: row.socket_url,
            sys_user_id: row.sys_user_id,
            team_name: row.team_name,
            team_size: row.team_size,
            user_ip: row.user_ip,
            webhook_url: row.webhook_url
          };

          // Step 4b: Get bot session data
          let sessionData = null;
          try {
            const sessionQuery = `SELECT jwt_token, device_id, fcm_token, mobile_no, session_token FROM sessions WHERE user_id = ?`;
            const sessionResult = await this.session.execute(sessionQuery, [botUserData.user_id], { prepare: true });
            if (sessionResult.rowLength > 0) {
              const sessionRow = sessionResult.first();
              sessionData = {
                jwt_token: sessionRow.jwt_token || '',
                device_id: sessionRow.device_id || '',
                fcm_token: sessionRow.fcm_token || '',
                mobile_no: sessionRow.mobile_no || '',
                session_token: sessionRow.session_token || ''
              };
            }
          } catch (err) {
            // No session data for this bot, try next bot
            continue;
          }

          if (!sessionData) {
            continue; // No session data, try next bot
          }

          // Step 4c: Call bot start API
          const payload = {
            jwtToken: sessionData.jwt_token || '',
            userId: botUserData.user_id || '',
            contestId: String(contestId),
            deviceId: sessionData.device_id || '',
            sessionToken: sessionData.session_token || '',
            gameId: 'snakes',
            socketUrl: botUserData.socket_url || 'http://localhost:3016',
            baseUrl: botUserData.base_url || 'http://localhost:8088/api',
            mobileNo: sessionData.mobile_no || '',
            fcmToken: sessionData.fcm_token || '',
            teamName: botUserData.team_name || '',
            teamSize: botUserData.team_size || 1,
            userIp: botUserData.user_ip || '',
            redisHost: botUserData.redis_host || '127.0.0.1',
            redisPort: botUserData.redis_port || 6379,
            redisUsername: botUserData.redis_username || '',
            redisPassword: botUserData.redis_password || '',
            redisDb: botUserData.redis_db || 0,
            botName: botUserData.bot_name || '',
            bot_id: botUserData.bot_id || ''
          };

          try {
            const response = await axios.post(apiUrl, payload, {
              headers: { 'Content-Type': 'application/json' },
              timeout: 10000 // 10 seconds timeout
            });
            // If API call succeeds (status 2xx), break the loop
            if (response && response.status >= 200 && response.status < 300) {
              apiSuccess = true;
              break; // Success! Exit loop
            }
          } catch (error) {
            console.error('Error calling bot start API:', error);
            // API call failed for this bot, continue to next bot
            continue;
          }
        } catch (err) {
          console.error('Error getting bot data:', err);
          // Error getting bot data, try next bot
          continue;
        }
      }

    } catch (err) {
      console.error('Error in maybeSendExpiryWarning:', err);
      // Silent fail
    }
  }
}

module.exports = { SnakesMatchmakingService };
