const axios = require('axios');
const { RedisService, getRedisService } = require('../../utils/redis');
const { config } = require('../../utils/config');
const { v4: uuidv4 } = require('uuid');

const SERVER_ID = config.serverId;
const {
    GAME_STATUS,
    REDIS_TTL,
    REDIS_KEYS,
    DB_QUERIES,
    getContestTypeMaxChances
} = require('../../constants');
const {
    toDate,
    getRowValue,
    sanitizeLeagueIds,
    resolveOpponentLeagueId,
    toInterfaceSlice
} = require('../../utils/dataUtils');

const LUDO_SELECT_PENDING = DB_QUERIES.LUDO_SELECT_PENDING;
const LUDO_UPDATE_PENDING_OPPONENT = DB_QUERIES.LUDO_UPDATE_PENDING_OPPONENT;
const LUDO_DELETE_PENDING = DB_QUERIES.LUDO_DELETE_PENDING;
const LUDO_EXPIRE_PENDING = DB_QUERIES.LUDO_EXPIRE_PENDING;
const LUDO_UPDATE_IDS_BY_LID = DB_QUERIES.LUDO_UPDATE_IDS_BY_LID;
const { updateLeagueJoinById, updateLeagueJoinByIdExpired } = require('../../services/ludo/gameService');

function getRows(result) {
    if (Array.isArray(result?.[0])) return result[0];
    if (Array.isArray(result?.rows)) return result.rows;
    return [];
}

function getFirstRow(result) {
    const rows = getRows(result);
    return rows.length > 0 ? rows[0] : null;
}

function normalizeString(value) {
    if (value === null || value === undefined) return '';
    return String(value).trim();
}

// ============================================================================
// Matchmaking constants (timings / retries)
// ============================================================================

const MATCHMAKING_CUTOFF_MS = 20_000;
const EXPIRY_WARNING_START_OFFSET_MS = 10_000;
const EXPIRY_WARNING_END_OFFSET_MS = 6_000;
const MAX_MATCHMAKING_USERS_PER_TICK = Number(process.env.LUDO_MATCHMAKING_MAX_USERS_PER_TICK || 10000);

// ============================================================================
// Small functional helpers (pure / reusable)
// ============================================================================

// pending entry cutoff helpers
// ============================================================================

const isExpired = (joinedAt, cutoff) => joinedAt < cutoff;

// ============================================================================
// expiry window helper
// ============================================================================

const isInWindow = (joinedAt, start, end) => joinedAt >= start && joinedAt < end;

// ============================================================================
// quick compatibility check between two pending users
// ============================================================================

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
    // ============================================================================
    // Constructor
    // ============================================================================
    constructor(session) {
        this.session = session;
        this.redis = null;
        this.redisInitialized = false;
        this.sessionConnectionName = 'default';
    }

    // ============================================================================
    // ensure redis client exists
    // ============================================================================
    async initializeRedis() {
        if (this.redisInitialized) return;
        const hasSessionRedis = config.redis.session.url && config.redis.session.url.trim() !== '';
        const connectionNames = hasSessionRedis ? ['session', 'default'] : ['default'];
        this.redis = new RedisService(connectionNames);
        this.sessionConnectionName = hasSessionRedis ? 'session' : 'default';
        this.redisInitialized = true;
    }

    // ============================================================================
    // close redis connections
    // ============================================================================
    async close() {
        if (this.redis) {
            await this.redis.close();
            this.redis = null;
            this.redisInitialized = false;
        }
    }

    // ============================================================================
    // ensure a user's session exists in redis caches
    // ============================================================================
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

    // ============================================================================
    // ensure sessions for both players
    // ============================================================================
    async ensureSessionsForMatch(user1Id, user2Id) {
        await Promise.all([this.ensureSessionForUser(user1Id), this.ensureSessionForUser(user2Id)]);
    }

    // ============================================================================
    // fetch latest active session for a user
    // ============================================================================
    async getActiveSession(userId) {
        if (userId == null) {
            return null;
        }
        const query = `SELECT user_id, device_id, expires_at, fcm_token, is_active, jwt_token, mobile_no, session_token, updated_at FROM sessions WHERE user_id = ?`;
        const result = await this.session.execute(query, [userId]);
        const row = getFirstRow(result);
        if (!row) return null;
        if (!row.is_active) return null;
        return row;
    }

    // ============================================================================
    // cache session details in redis
    // ============================================================================
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
// Ludo Matchmaking Service
// ============================================================================

class LudoMatchmakingService {
    // ============================================================================
    // Constructor
    // ============================================================================
    constructor(session) {
        this.session = session;
    }

    async _execute(query, params = []) {
        return this.session.execute(query, params);
    }

    async removeContestJoinCache(user) {
        if (!user || !user.userId) return;
        const redisService = getRedisService();
        const userId = String(user.userId);
        const contestId = String(user.contestId || user.leagueId || '');
        const lid = String(user.id || '');

        const keys = [];
        if (contestId && lid) {
            keys.push(`contest_join:${userId}:${contestId}:${lid}`);
        }
        if (contestId) {
            // backward compatibility key patterns
            keys.push(`contest_join:${contestId}:${userId}`);
        }
        keys.push(`contest_join:${userId}`);

        for (const key of keys) {
            try {
                await redisService.del(key);
            } catch (_) {
            }
        }

        // Safety cleanup: remove all keys for this user+contest regardless of l_id.
        if (contestId) {
            try {
                const patternKeys = await redisService.scan(`contest_join:${userId}:${contestId}:*`, { count: 200 });
                for (const key of patternKeys) {
                    try {
                        await redisService.del(key);
                    } catch (_) {
                    }
                }
            } catch (_) {
            }
        }

        // Strong cleanup: remove by user + l_id across any contest segment.
        if (lid) {
            try {
                const lidPatternKeys = await redisService.scan(`contest_join:${userId}:*:${lid}`, { count: 200 });
                for (const key of lidPatternKeys) {
                    try {
                        await redisService.del(key);
                    } catch (_) {
                    }
                }
            } catch (_) {
            }
        }
    }

    // ============================================================================
    // build sanitized pending user object
    // ============================================================================
    _buildPendingUser(row) {
        const userId = getRowValue(row, 'user_id');
        const joinedAt = toDate(getRowValue(row, 'joined_at'));
        if (!userId || !joinedAt) return null;

        const b_s = getRowValue(row, 'b_s');
        const b_sValue = b_s === true || b_s === 'true' || b_s === 1 || b_s === '1' ? true : false;

        return {
            userId,
            leagueId: getRowValue(row, 'league_id'),
            contestId: getRowValue(row, 'contest_id'),
            joinedAt,
            id: getRowValue(row, 'id') ? String(getRowValue(row, 'id')) : '',
            gameModeId: getRowValue(row, 'gameModeId'),
            gameHistoryId: getRowValue(row, 'gameHistoryId'),
            statusId: getRowValue(row, 'status_id'),
            joinDay: getRowValue(row, 'join_day'),
            extraData: getRowValue(row, 'extra_data'),
            gameType: getRowValue(row, 'game_type'),
            contestType: getRowValue(row, 'contest_type'),
            serverId: getRowValue(row, 'server_id') || SERVER_ID,
            b_s: b_sValue
        };
    }

    // ============================================================================
    // load pending users across join days
    // ============================================================================
    async _loadPendingUsers(leagueIdsArray) {
        const users = [];
        if (leagueIdsArray.length === 0) return users;

        const placeholders = leagueIdsArray.map(() => '?').join(',');
        const query = LUDO_SELECT_PENDING.replace('%LEAGUE_IDS%', placeholders);
        const params = ['pending', Number(GAME_STATUS.PENDING), 'ludo', ...leagueIdsArray, String(SERVER_ID)];
        const result = await this._execute(query, params);
        const rows = Array.isArray(result?.[0]) ? result[0] : (result?.rows || []);

        for (const row of rows) {
            const user = this._buildPendingUser(row);
            if (user) users.push(user);
        }

        return users;
    }

    // ============================================================================
    // matchmaking entry point
    // ============================================================================
    async processMatchmakingForLeagues(leagueIds) {
        const leagueIdsArray = sanitizeLeagueIds(leagueIds);
        if (leagueIdsArray.length === 0) return;

        const matchedUsers = new Set();
        const redisService = getRedisService();
        const notifiedUsersKeyPrefix = 'ludo_expiry_notified:';
        const notificationTTL = 15;
        let pendingSlot = null;
        const cutoff = new Date(Date.now() - MATCHMAKING_CUTOFF_MS);
        const pendingUsersRaw = await this._loadPendingUsers(leagueIdsArray);
        const pendingUsers = Array.isArray(pendingUsersRaw)
            ? pendingUsersRaw
                .sort((a, b) => {
                    const at = a?.joinedAt ? new Date(a.joinedAt).getTime() : 0;
                    const bt = b?.joinedAt ? new Date(b.joinedAt).getTime() : 0;
                    return at - bt;
                })
                .slice(0, Math.max(1, MAX_MATCHMAKING_USERS_PER_TICK))
            : [];
        const expiryWarningStart = new Date(Date.now() - EXPIRY_WARNING_START_OFFSET_MS);
        const expiryWarningEnd = new Date(Date.now() - EXPIRY_WARNING_END_OFFSET_MS);

        const expireSafe = async (user) => {
            if (!user) return;
            try {
                await this.expirePending(user);
            } catch (err) {

            }
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

            // await this.maybeSendExpiryWarning(user, expiryWarningStart, expiryWarningEnd, redisService, notifiedUsersKeyPrefix, notificationTTL);

            if (matchedUsers.has(user.userId)) continue;
            if (!pendingSlot) {
                pendingSlot = user;
                continue;
            }

            if (!canPairUsers(pendingSlot, user)) continue;

            try {
                await this.createLudoMatch(pendingSlot, user);
                matchedUsers.add(pendingSlot.userId);
                matchedUsers.add(user.userId);
            } catch (err) {

            }

            pendingSlot = null;
        }

        if (!pendingSlot) return;
        if (isExpired(pendingSlot.joinedAt, cutoff)) {
            await expireSafe(pendingSlot);
            return;
        }
        // Disabled for current flow: keep function for system-user flow reference.
        // await this.maybeSendExpiryWarning(pendingSlot, expiryWarningStart, expiryWarningEnd, redisService, notifiedUsersKeyPrefix, notificationTTL);
    }

    // ============================================================================
    // create match (pieces, dice, redis state)
    // ============================================================================
    async createLudoMatch(user1, user2) {
        if (!user1 || !user2 || !user1.userId || !user2.userId) {
            throw new Error('Invalid user data for match creation');
        }

        const matchPairId = await this.createMatchPairEntry(user1, user2);

        const buildInitialPieces = (userId, count = 4) => {
            const pieces = [];
            for (let i = 1; i <= count; i += 1) {
                pieces.push({
                    game_id: matchPairId,
                    user_id: userId,
                    move_number: 0,
                    piece_id: uuidv4(),
                    player_id: '',
                    from_pos_last: 'initial',
                    to_pos_last: 'initial',
                    piece_type: `piece_${i}`,
                    captured_piece: '',
                    created_at: new Date().toISOString(),
                    updated_at: new Date().toISOString()
                });
            }
            return pieces;
        };

        const user1PiecesIface = toInterfaceSlice(buildInitialPieces(user1.userId));
        const user2PiecesIface = toInterfaceSlice(buildInitialPieces(user2.userId));
        const user1DiceIface = toInterfaceSlice([{ dice_id: uuidv4(), created_at: new Date().toISOString() }]);
        const user2DiceIface = toInterfaceSlice([{ dice_id: uuidv4(), created_at: new Date().toISOString() }]);

        await this.updateUsersAndPending(user1, user2, matchPairId, {
            user1Pieces: user1PiecesIface,
            user2Pieces: user2PiecesIface,
            user1Dice: user1DiceIface,
            user2Dice: user2DiceIface
        });
        await this.storeLudoMatch(matchPairId, user1, user2, {
            user1Pieces: user1PiecesIface,
            user2Pieces: user2PiecesIface,
            user1Dice: user1DiceIface,
            user2Dice: user2DiceIface
        });
        try {
            await this.notifyMatchStart(user1, user2, matchPairId);
        } catch (err) {
            console.error('[LudoCron] match/start notify failed:', err?.message || String(err));
        }
        await this.ensureSessions(user1.userId, user2.userId);
        return matchPairId;
    }

    async notifyMatchStart(user1, user2, matchPairId = '') {
        const baseUrl = (process.env.MATCH_START_API_BASE_URL || '').trim();
        const endpoint = (process.env.MATCH_START_API_ENDPOINT || '').trim();
        const gameMatchKey = (process.env.MATCH_START_API_GAME_MATCH_KEY || '').trim();
        const timeout = Number(process.env.MATCH_START_API_TIMEOUT_MS || 5000);
        const defaultGameId = normalizeString(process.env.MATCH_START_API_GAME_ID || '5');
        const defaultGameModeId = normalizeString(process.env.MATCH_START_API_DEFAULT_GAME_MODE_ID || '1');

        if (!baseUrl || !endpoint || !gameMatchKey) return;

        const normalizedBaseUrl = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
        const normalizedEndpoint = endpoint.startsWith('/') ? endpoint : `/${endpoint}`;
        const url = `${normalizedBaseUrl}${normalizedEndpoint}`;

        const user1Id = Number(user1?.userId);
        const user2Id = Number(user2?.userId);
        if (!Number.isFinite(user1Id) || !Number.isFinite(user2Id)) return;

        const resolvedGameModeId = Number.isNaN(Number(user1?.gameModeId))
            ? Number(defaultGameModeId)
            : Number(user1.gameModeId);
        const payload = {
            gameId: defaultGameId,
            gameModeId: Number.isFinite(resolvedGameModeId) ? resolvedGameModeId : Number(defaultGameModeId),
            lobbyId: normalizeString(user1?.contestId || user1?.leagueId || ''),
            playerUserIds: [user1Id, user2Id],
            gameData: {},
            match_pair_id: normalizeString(matchPairId),
            playersResultExtra: {}
        };

        try {
            await axios.post(url, payload, {
                headers: {
                    'Content-Type': 'application/json',
                    'X-Game-Match-Key': gameMatchKey
                },
                timeout
            });
        } catch (err) {
            
        }
    }

    // ============================================================================
    // create base match pair entry
    // ============================================================================
    async createMatchPairEntry(user1, user2) {
        const matchPairId = uuidv4();
        // Match metadata/status is now tracked in ludo_game via updateLeagueJoinById().
        return matchPairId;
    }

    // ============================================================================
    // update users and cleanup pending queues
    // ============================================================================
    async updateUsersAndPending(user1, user2, matchPairId, ids = {}) {
        let turnId1 = 1;
        let turnId2 = 2;
        if (!(user1.joinedAt < user2.joinedAt)) {
            turnId1 = 2;
            turnId2 = 1;
        }

        await this.updateUserWithOpponent(user1, user2.userId, matchPairId, turnId1, user2.leagueId, {
            userDice: ids.user1Dice,
            opponentDice: ids.user2Dice,
            userPieces: ids.user1Pieces,
            opponentPieces: ids.user2Pieces
        });
        await this.updateUserWithOpponent(user2, user1.userId, matchPairId, turnId2, user1.leagueId, {
            userDice: ids.user2Dice,
            opponentDice: ids.user1Dice,
            userPieces: ids.user2Pieces,
            opponentPieces: ids.user1Pieces
        });

        await this.updatePendingOpponent(user1, user2.userId);
        await this.updatePendingOpponent(user2, user1.userId);

        await this.deletePending(user1);
        await this.deletePending(user2);

        // Keep redis contest-join cache in sync after match creation.
        await this.removeContestJoinCache(user1);
        await this.removeContestJoinCache(user2);
    }

    // ============================================================================
    // write user opponent details into league join
    // ============================================================================
    async updateUserWithOpponent(user, opponentUserId, matchPairId, turnId, opponentLeagueId, ids = {}) {
        const resolvedLeagueId = resolveOpponentLeagueId(opponentLeagueId, user.leagueId);

        // Primary match linkage/state in ludo_game
        if (user.id) {
            try {
                await updateLeagueJoinById(user.id, opponentUserId, GAME_STATUS.MATCHED, {
                    matchPairId: matchPairId,
                    turnId: turnId,
                    opponentLeagueId: resolvedLeagueId
                });

                const userDiceId = ids.userDice?.[0]?.dice_id || null;
                const opponentDiceId = ids.opponentDice?.[0]?.dice_id || null;
                const userPieceIds = Array.isArray(ids.userPieces) ? ids.userPieces.map((p) => p?.piece_id || null) : [];
                const opponentPieceIds = Array.isArray(ids.opponentPieces) ? ids.opponentPieces.map((p) => p?.piece_id || null) : [];

                await this._execute(LUDO_UPDATE_IDS_BY_LID, [
                    userDiceId,
                    opponentDiceId,
                    userPieceIds[0] || null,
                    userPieceIds[1] || null,
                    userPieceIds[2] || null,
                    userPieceIds[3] || null,
                    opponentPieceIds[0] || null,
                    opponentPieceIds[1] || null,
                    opponentPieceIds[2] || null,
                    opponentPieceIds[3] || null,
                    user.id
                ]);
            } catch (err) {
            }
        }
    }

    // ============================================================================
    // update pending table opponent id
    // ============================================================================
    async updatePendingOpponent(user, opponentUserId) {
        const serverId = user.serverId || SERVER_ID;
        await this._execute(
            LUDO_UPDATE_PENDING_OPPONENT,
            [opponentUserId, user.userId, user.statusId, user.joinDay, user.leagueId, String(serverId), user.joinedAt]
        );
    }

    // ============================================================================
    // delete pending entries
    // ============================================================================
    async deletePending(user) {
        // In MySQL single-table ludo flow, pending/matched/active live in the same row.
        // Marking pending rows as deleted here removes matched rows from check:opponent lookups.
        // Keep as no-op.
        return;
    }

    // ============================================================================
    // cache ludo match data in redis
    // ============================================================================
    async storeLudoMatch(matchPairId, user1, user2, { user1Pieces, user2Pieces, user1Dice, user2Dice }) {
        const redisService = getRedisService();
        const startTime = new Date().toISOString();
        const turn = user1.joinedAt > user2.joinedAt ? user2.userId : user1.userId;
        const maxChances = getContestTypeMaxChances(user1.contestType);
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
            league_id: user1.leagueId
        };
        await redisService.set(REDIS_KEYS.MATCH(matchPairId), matchData, REDIS_TTL.MATCH_SECONDS);
        await redisService.set(`match_server:${String(matchPairId)}:${String(user1.serverId || SERVER_ID)}`, {
            game_id: String(matchPairId),
            server_id: String(user1.serverId || SERVER_ID)
        }, REDIS_TTL.MATCH_SECONDS);
    }

    // ============================================================================
    // ensure both users have active sessions cached
    // ============================================================================
    async ensureSessions(user1Id, user2Id) {
        const sessionService = new SessionService(this.session);
        try {
            await sessionService.ensureSessionsForMatch(user1Id, user2Id);
        } finally {
            await sessionService.close();
        }
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
            const maxUserId = 100;
            const apiUrl = 'http://localhost:3001/api/bot/start';
            const contestId = user.leagueId || user.contestType || '9';
            let apiSuccess = false;

            for (let userId = 1; userId <= maxUserId; userId++) {
                try {
                    // Step 4a: Get bot user data
                    const botQuery = `SELECT user_id, status, base_url, bot_name, redis_db, redis_host, redis_password, 
                                    redis_port, redis_username, socket_url, sys_user_id, team_name, team_size, user_ip, webhook_url 
                                    FROM bot_user_ids 
                                    WHERE user_id = ? AND status = ?`;
                    const botResult = await this._execute(botQuery, [userId.toString(), false]);
                    const botRow = getFirstRow(botResult);
                    if (!botRow) {
                        continue; // No bot found for this ID, try next
                    }

                    const row = botRow;
                    const sysUserIdString = row.sys_user_id && typeof row.sys_user_id === 'object' && row.sys_user_id.toString ? row.sys_user_id.toString() : String(row.sys_user_id || '');
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
                        const sessionResult = await this._execute(sessionQuery, [botUserData.user_id]);
                        const sessionRow = getFirstRow(sessionResult);
                        if (sessionRow) {
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
                        gameId: 'ludo',
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
                            headers: {
                                'Content-Type': 'application/json'
                            },
                            timeout: 10000 // 10 seconds timeout
                        });
                       // If API call succeeds (status 2xx), break the loop
                        if (response && response.status >= 200 && response.status < 300) {
                            apiSuccess = true;
                            break; // Success! Exit loop
                        }
                    } catch (error) {
                        // API call failed for this bot, continue to next bot
                        continue;
                    }
                } catch (err) {
                    // Silently skip bots with errors (expected for missing/invalid bots)
                    // Error getting bot data, try next bot
                    continue;
                }
            }

        } catch (err) {
            // Silent fail
        }
    }

    // ============================================================================
    // expire pending entry and refund
    // ============================================================================
    async expirePending(user) {
        try {
            try {
                await this.processExpiredEntryRefund(user);
            } catch (err) {
            }
            const serverId = user.serverId || SERVER_ID;
            await this._execute(
                LUDO_EXPIRE_PENDING,
                [GAME_STATUS.EXPIRED, 6, user.userId, user.statusId, user.joinDay, user.leagueId, String(serverId), user.joinedAt]
            );

            // Also update league_joins_by_id for fast lookups
            if (user.id) {
                try {
                    await updateLeagueJoinByIdExpired(user.id, GAME_STATUS.EXPIRED);
                } catch (err) {
                }
            }
        } finally {
            // Always attempt cache cleanup even if DB update fails.
            await this.removeContestJoinCache(user);
        }
    }

    // ============================================================================
    // trigger refund for expired entry
    // ============================================================================
    async processExpiredEntryRefund(user) {
        const refundApiUrl = (process.env.LUDO_REFUND_API_URL || '').trim();
        if (!refundApiUrl) return;

        const payload = {
            user_id: String(user.userId || ''),
            l_id: String(user.id || ''),
            contest_id: String(user.leagueId || ''),
            league_id: String(user.leagueId || ''),
            reason: 'matchmaking_timeout_refund',
            joined_at: user.joinedAt ? new Date(user.joinedAt).toISOString() : new Date().toISOString()
        };

        await axios.post(refundApiUrl, payload, {
            headers: { 'Content-Type': 'application/json' },
            timeout: Number(process.env.LUDO_REFUND_API_TIMEOUT_MS || 5000)
        });
    }
}

module.exports = { LudoMatchmakingService };
