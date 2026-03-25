// ============================================================================
// Imports
// ============================================================================

const cassandra = require('cassandra-driver');
const { WinnerDeclarationService } = require('../services/winnerService');
const { RedisService, getRedisService } = require('../../utils/redis');
const { config } = require('../../utils/config');

const SERVER_ID = config.serverId;
const {
  GAME_STATUS,
  REDIS_TTL,
  REDIS_KEYS,
  DB_QUERIES,
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
  resolveOpponentLeagueId
} = require('../../utils/dataUtils');

const SELECT_PENDING = DB_QUERIES.SELECT_PENDING;
const INSERT_MATCH_PAIR = DB_QUERIES.INSERT_MATCH_PAIR;
const UPDATE_PENDING_OPPONENT = DB_QUERIES.UPDATE_PENDING_OPPONENT;
const DELETE_PENDING = DB_QUERIES.DELETE_PENDING;
const DELETE_PENDING_BY_STATUS = DB_QUERIES.DELETE_PENDING_BY_STATUS;
const UPDATE_LEAGUE_JOIN = DB_QUERIES.UPDATE_LEAGUE_JOIN;
const UPDATE_LEAGUE_EXPIRED = DB_QUERIES.UPDATE_LEAGUE_EXPIRED;
const SELECT_LEAGUE_JOIN_EXTRA = DB_QUERIES.SELECT_LEAGUE_JOIN_EXTRA;
const SELECT_USER_DETAILS = DB_QUERIES.SELECT_USER_DETAILS;
const INSERT_GAME_MOVE = DB_QUERIES.INSERT_GAME_MOVE;
const { updateLeagueJoinById, updateLeagueJoinByIdExpired } = require('../../services/ludo/gameService');

const MATCHMAKING_CUTOFF_MS = 10_000;
const isExpired = (joinedAt, cutoff) => joinedAt < cutoff;
const canPairUsers = (a, b) => {
  if (!a || !b) return false;
  if (a.userId === b.userId) return false;
  if (a.leagueId !== b.leagueId) return false;
  if (a.gameType !== b.gameType) return false;
  if (a.contestType !== b.contestType) return false;
  return true;
};

function normalizeWaterSortGameType(gameType) {
  if (!gameType) return 'watersort';
  const value = String(gameType).trim().toLowerCase();
  if (
    value === 'water-sort-battle' ||
    value === 'water_sort_battle' ||
    value === 'water_sort' ||
    value === 'watersort'
  ) {
    return 'watersort';
  }
  return value;
}

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
// Water Sort Matchmaking Service
// ============================================================================

class WaterSortMatchmakingService {
  constructor(session) {
    this.session = session;
  }

  getCassandraSession() {
    return this.session;
  }

  async processWaterSortMatchmaking(leagueIds) {
    const leagueIdsArray = sanitizeLeagueIds(leagueIds);
    if (leagueIdsArray.length === 0) {
      return;
    }

    const expireSafe = async (user) => {
      if (!user) return;
      try {
        await this.expirePending(user);
      } catch (err) {}
    };

    const today = new Date();
    const yesterday = new Date(today.getTime() - 24 * 60 * 60 * 1000);
    const joinDays = [getTodayString(today), getTodayString(yesterday)];

    const pendingUsers = [];
    for (const joinDay of joinDays) {
      const result = await this.session.execute(
        SELECT_PENDING,
        [GAME_STATUS.PENDING, joinDay, leagueIdsArray, SERVER_ID],
        { prepare: true }
      );
      for (const row of result.rows) {
        const userId = getRowValue(row, 'user_id');
        const joinedAt = toDate(getRowValue(row, 'joined_at'));
        if (!userId || !joinedAt) continue;

        const rawGameType = getRowValue(row, 'game_type');
        pendingUsers.push({
          userId,
          leagueId: getRowValue(row, 'league_id'),
          joinedAt,
          id: normalizeUuid(getRowValue(row, 'id')),
          statusId: getRowValue(row, 'status_id'),
          joinDay: getRowValue(row, 'join_day'),
          extraData: getRowValue(row, 'extra_data'),
          gameType: normalizeWaterSortGameType(rawGameType),
          contestType: getRowValue(row, 'contest_type'),
          serverId: getRowValue(row, 'server_id') || SERVER_ID
        });
      }
    }

    const matchedUsers = new Set();
    let pendingSlot = null;
    const cutoff = new Date(Date.now() - MATCHMAKING_CUTOFF_MS);

    for (const user of pendingUsers) {
      if (isExpired(user.joinedAt, cutoff)) {
        await expireSafe(user);
        continue;
      }
      if (pendingSlot && isExpired(pendingSlot.joinedAt, cutoff)) {
        await expireSafe(pendingSlot);
        pendingSlot = null;
      }
      if (matchedUsers.has(user.userId)) {
        continue;
      }
      if (!pendingSlot) {
        pendingSlot = user;
        continue;
      }
      if (!canPairUsers(pendingSlot, user)) continue;

      try {
        await this.createWaterSortMatch(pendingSlot, user);
        matchedUsers.add(pendingSlot.userId);
        matchedUsers.add(user.userId);
      } catch (err) {}
      pendingSlot = null;
    }

    if (!pendingSlot) return;
    if (isExpired(pendingSlot.joinedAt, cutoff)) {
      await expireSafe(pendingSlot);
    }
  }

  async createWaterSortMatch(user1, user2) {
    const matchPairId = await this.createMatchPairEntry(user1, user2);
    await this.updateUsersAndPending(user1, user2, matchPairId);
    await this.storeWaterSortMatch(matchPairId, user1, user2);
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
      } catch (err) {}
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
    const serverId = user.serverId || SERVER_ID;
    await Promise.all([
      this.session.execute(DELETE_PENDING, [user.statusId, user.joinDay, user.leagueId, serverId, user.joinedAt], { prepare: true }),
      this.session.execute(DELETE_PENDING_BY_STATUS, [user.userId, user.statusId, user.joinedAt], { prepare: true })
    ]);
  }

  async storeWaterSortMatch(matchPairId, user1, user2) {
    const redisService = getRedisService();
    const startTime = new Date().toISOString();
    // Pass matchPairId to buildWaterSortLevels to ensure deterministic level generation
    // Both users will get the SAME 5 levels for this match
    const [user1Details, user2Details, levelData] = await Promise.all([
      this.getUserDetails(user1.userId),
      this.getUserDetails(user2.userId),
      this.buildWaterSortLevels(matchPairId)
    ]);
    const puzzleState = { levels: levelData.levels };
    const matchData = {
      game_id: matchPairId,
      user1_id: user1.userId,
      user2_id: user2.userId,
      game_status: GAME_STATUS.ACTIVE,
      winner: '',
      user1_time: startTime,
      user2_time: startTime,
      start_time: startTime,
      end_time: new Date(Date.now() + 300 * 1000).toISOString(),
      puzzle_state: puzzleState,
      move_count: 0,
      move_sequence: [],
      user1_connection_count: 0,
      user2_connection_count: 0,
      user1_score: 0,
      user2_score: 0,
      user1_chance: 1,
      user2_chance: 1,
      game_type: user1.gameType,
      contest_type: user1.contestType,
      league_id: user1.leagueId,
      user1_full_name: user1Details.fullName,
      user1_profile_data: user1Details.profileData,
      user2_full_name: user2Details.fullName,
      user2_profile_data: user2Details.profileData
    };
    await redisService.set(REDIS_KEYS.WATERSORT_MATCH(matchPairId), matchData, REDIS_TTL.MATCH_SECONDS);
    await redisService.set(
      REDIS_KEYS.WATERSORT_USER_CHANCE(matchPairId),
      {
        [user1.userId]: 1,
        [user2.userId]: 1
      },
      REDIS_TTL.MATCH_SECONDS
    );

    const initData = {
      init: true,
      level_no: levelData.currentLevel,
      puzzle_state: puzzleState,
      contest_type: user1.contestType,
      game_type: user1.gameType
    };
    const now = new Date();
    await this.session.execute(
      INSERT_GAME_MOVE,
      [matchPairId, user1.userId, 'watersort', 'init', 0, JSON.stringify(initData), 0, 0, 0, 0, 0, 0, '', 0, now, now],
      { prepare: true }
    );
    await this.session.execute(
      INSERT_GAME_MOVE,
      [matchPairId, user2.userId, 'watersort', 'init', 0, JSON.stringify(initData), 0, 0, 0, 0, 0, 0, '', 0, now, now],
      { prepare: true }
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

  async buildWaterSortLevels(matchPairId = null) {
    // COMPULSORY: Always create exactly 5 levels (one for each stage)
    // Use matchPairId as seed to ensure both users get the SAME levels
    const levelRanges = [
      [1, 50],
      [50, 100],
      [100, 200],
      [200, 300],
      [300, 400]
    ];
    const levels = [];
    let currentLevel = 1;

    // Create deterministic seed from matchPairId so both users get same levels
    let seed = 0;
    if (matchPairId) {
      seed = matchPairId.toString().split('').reduce((acc, char) => acc + char.charCodeAt(0), 0);
    } else {
      seed = Date.now();
    }

    // Ensure exactly 5 levels are created
    for (let i = 0; i < 5; i++) {
      const [min, max] = levelRanges[i];

      // Use deterministic selection based on seed + index
      // This ensures both users get the same levels for the same match
      const deterministicSeed = (seed + i * 1000) % 1000000;
      const rangeSize = max - min + 1;
      let levelNo = min + (deterministicSeed % rangeSize);

      let levelMap = await this.getWaterSortLevelMapData(levelNo);
      if (!levelMap || levelMap.length === 0) {
        levelNo = 1;
        levelMap = await this.getWaterSortLevelMapData(1);
      }
      if (!levelMap || levelMap.length === 0) {
        levelNo = 1;
        levelMap = [
          { values: [] },
          { values: [] },
          { values: [] },
          { values: [] }
        ];
      }
      if (i === 0) {
        currentLevel = levelNo;
      }
      levels.push({ no: levelNo, map: levelMap });
    }

    // Ensure exactly 5 levels are returned
    if (levels.length !== 5) {
      // Fallback: pad with default levels if needed
      while (levels.length < 5) {
        levels.push({
          no: 1,
          map: [
            { values: [] },
            { values: [] },
            { values: [] },
            { values: [] }
          ]
        });
      }
    }

    return { currentLevel, levels };
  }

  async getWaterSortLevelMapData(levelNo) {
    // Use cached level service instead of direct database query
    const { getWaterSortLevelMapData: getCachedLevel } = require('../../services/watersort/levelCacheService');
    return await getCachedLevel(levelNo);
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
    } catch (err) {}
    const joinMonth = getCurrentMonth(user.joinedAt);
    const serverId = user.serverId || SERVER_ID;
    await Promise.all([
      this.session.execute(DELETE_PENDING, [user.statusId, user.joinDay, user.leagueId, serverId, user.joinedAt], { prepare: true }),
      this.session.execute(DELETE_PENDING_BY_STATUS, [user.userId, user.statusId, user.joinedAt], { prepare: true }),
      this.session.execute(UPDATE_LEAGUE_EXPIRED, [GAME_STATUS.EXPIRED, user.userId, user.statusId, joinMonth, user.joinedAt], { prepare: true })
    ]);

    // Also update league_joins_by_id for fast lookups
    if (user.id) {
      try {
        await updateLeagueJoinByIdExpired(user.id, GAME_STATUS.EXPIRED, user.statusId);
      } catch (err) {}
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
}

// ============================================================================
// Exports
// ============================================================================

module.exports = { WaterSortMatchmakingService };
