const path = require('path');
const fs = require('fs/promises');
const crypto = require('crypto');
const Fastify = require('fastify');
const axios = require('axios');
const { GetObjectCommand, PutObjectCommand } = require('@aws-sdk/client-s3');
const mysqlClient = require('../services/mysql/client');
const { getRedisService } = require('../utils/redis');
const { getS3Client } = require('../utils/s3');
const { getGameStateJson } = require('../utils/s3');
const { config } = require('../utils/config');

let isRunning = false;
let adminIntervalId = null;
let adminServer = null;

let publicFiles = {
  loginHtml: '',
  dashboardHtml: '',
  liveHtml: '',
  historyHtml: '',
  usersHtml: '',
  css: '',
  js: ''
};

const sessions = new Map();

let authConfig = {
  users: [],
  source: 'env',
  s3Bucket: '',
  s3Key: ''
};

const state = {
  startedAt: null,
  lastTickAt: null,
  ticks: 0
};

const PUBLIC_DIR = path.resolve(__dirname, 'public');

function getCookieValue(cookieHeader, key) {
  const header = String(cookieHeader || '');
  if (!header) return '';
  const pairs = header.split(';');
  for (const pair of pairs) {
    const [rawKey, ...rest] = String(pair || '').trim().split('=');
    if (rawKey === key) {
      return decodeURIComponent(rest.join('=') || '');
    }
  }
  return '';
}

function buildSessionCookie(token) {
  return [
    `admin_session=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    'Max-Age=86400'
  ].join('; ');
}

function clearSessionCookie() {
  return 'admin_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0';
}

function isAuthenticated(request) {
  const token = getCookieValue(request?.headers?.cookie, 'admin_session');
  if (!token) return false;
  const session = sessions.get(token);
  if (!session) return false;
  if (!session.expires_at || Date.now() > session.expires_at) {
    sessions.delete(token);
    return false;
  }
  return true;
}

function getSession(request) {
  const token = getCookieValue(request?.headers?.cookie, 'admin_session');
  if (!token) return null;
  const session = sessions.get(token);
  if (!session) return null;
  if (!session.expires_at || Date.now() > session.expires_at) {
    sessions.delete(token);
    return null;
  }
  return session;
}

function getSessionUsername(request) {
  return String(getSession(request)?.username || '').trim();
}

function isEnvAdminUser(username) {
  const envAdminUser = String(process.env.ADMIN_USERNAME || '').trim();
  if (!envAdminUser) return false;
  return String(username || '').trim() === envAdminUser;
}

async function loadAdminUsersFromS3() {
  const bucket = String(process.env.ADMIN_AUTH_S3_BUCKET || config.s3.bucket || '').trim();
  const key = String(process.env.ADMIN_AUTH_S3_KEY || 'admin/login.json').trim();
  const envUsername = String(process.env.ADMIN_USERNAME || '').trim();
  const envPassword = String(process.env.ADMIN_PASSWORD || '');
  const hasEnvFallback = !!(envUsername && envPassword);
  if (!bucket) {
    if (!hasEnvFallback) {
      throw new Error('S3 bucket is missing and ADMIN_USERNAME/ADMIN_PASSWORD fallback is not set');
    }
    authConfig.users = [{ username: envUsername, password: envPassword }];
    authConfig.source = 'env';
    authConfig.s3Bucket = '';
    authConfig.s3Key = '';
    console.error('[Admin] using env login user because S3 bucket is missing');
    return;
  }

  try {
    const s3 = getS3Client();
    const result = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    const bodyBuffer = Buffer.from(await result.Body.transformToByteArray());
    const raw = bodyBuffer.toString('utf8');
    const parsed = JSON.parse(raw);

    let users = [];
    if (Array.isArray(parsed?.users)) {
      users = parsed.users;
    } else if (parsed?.username && parsed?.password) {
      users = [{ username: parsed.username, password: parsed.password }];
    }

    authConfig.users = users
      .map((u) => ({
        username: String(u?.username || '').trim(),
        password: String(u?.password || '')
      }))
      .filter((u) => u.username && u.password);

    if (!authConfig.users.length) {
      throw new Error('No valid users found in admin auth JSON');
    }
    authConfig.source = 's3';
    authConfig.s3Bucket = bucket;
    authConfig.s3Key = key;
  } catch (error) {
    if (!hasEnvFallback) {
      throw new Error(`Failed to load S3 auth users and ADMIN_USERNAME/ADMIN_PASSWORD fallback is not set: ${error?.message || error}`);
    }
    authConfig.users = [{ username: envUsername, password: envPassword }];
    authConfig.source = 's3';
    authConfig.s3Bucket = bucket;
    authConfig.s3Key = key;
    console.error(`[Admin] failed to load S3 auth users, bootstrapping from env user and keeping S3 target: ${error?.message || error}`);
  }
}

async function saveAdminUsersToS3() {
  if (authConfig.source !== 's3' || !authConfig.s3Bucket || !authConfig.s3Key) {
    throw new Error('User management persistence requires S3 auth config');
  }
  const payload = {
    users: authConfig.users.map((u) => ({
      username: String(u.username || '').trim(),
      password: String(u.password || '')
    }))
  };
  const s3 = getS3Client();
  await s3.send(new PutObjectCommand({
    Bucket: authConfig.s3Bucket,
    Key: authConfig.s3Key,
    Body: JSON.stringify(payload, null, 2),
    ContentType: 'application/json'
  }));
}

async function loadPublicFiles() {
  const [loginHtml, dashboardHtml, liveHtml, historyHtml, usersHtml, css, js] = await Promise.all([
    fs.readFile(path.join(PUBLIC_DIR, 'login.html'), 'utf8'),
    fs.readFile(path.join(PUBLIC_DIR, 'dashboard.html'), 'utf8'),
    fs.readFile(path.join(PUBLIC_DIR, 'live.html'), 'utf8'),
    fs.readFile(path.join(PUBLIC_DIR, 'history.html'), 'utf8'),
    fs.readFile(path.join(PUBLIC_DIR, 'users.html'), 'utf8'),
    fs.readFile(path.join(PUBLIC_DIR, 'style.css'), 'utf8'),
    fs.readFile(path.join(PUBLIC_DIR, 'app.js'), 'utf8')
  ]);
  publicFiles = { loginHtml, dashboardHtml, liveHtml, historyHtml, usersHtml, css, js };
}

async function getRedisCounts() {
  const redis = getRedisService();
  const scanCount = Math.max(50, Number(process.env.ADMIN_SCAN_COUNT || 1000));

  const [matchKeys, matchServerKeys, contestJoinKeys, userToSocketKeys, socketToUserKeys] = await Promise.all([
    redis.scan('match:*', { count: scanCount }),
    redis.scan('match_server:*', { count: scanCount }),
    redis.scan('contest_join:*', { count: scanCount }),
    redis.scan('user_to_socket:*', { count: scanCount }),
    redis.scan('socket_to_user:*', { count: scanCount })
  ]);

  return {
    match_keys: Array.isArray(matchKeys) ? matchKeys.length : 0,
    match_server_keys: Array.isArray(matchServerKeys) ? matchServerKeys.length : 0,
    contest_join_keys: Array.isArray(contestJoinKeys) ? contestJoinKeys.length : 0,
    user_to_socket_keys: Array.isArray(userToSocketKeys) ? userToSocketKeys.length : 0,
    socket_to_user_keys: Array.isArray(socketToUserKeys) ? socketToUserKeys.length : 0
  };
}

async function getMysqlSummary() {
  const [statusRows] = await mysqlClient.query(
    `SELECT status, COUNT(*) AS count
     FROM ludo_game
     WHERE is_deleted = 0
     GROUP BY status
     ORDER BY status`
  );

  const [recentRows] = await mysqlClient.query(
    `SELECT match_id, status, user_id, opponent_user_id, contest_id, updated_at
     FROM ludo_game
     WHERE is_deleted = 0 AND match_id IS NOT NULL
     ORDER BY updated_at DESC
     LIMIT 25`
  );

  return {
    mysql_status_counts: Array.isArray(statusRows) ? statusRows : [],
    recent_matches: Array.isArray(recentRows) ? recentRows : []
  };
}

async function getLiveData() {
  const redis = getRedisService();
  const redis_counts = await getRedisCounts();
  const scanCount = Math.max(50, Number(process.env.ADMIN_SCAN_COUNT || 1000));
  const serverId = String(process.env.SERVER_ID || '1');

  const [matchServerKeys, matchKeys, contestJoinKeys] = await Promise.all([
    redis.scan(`match_server:*:${serverId}`, { count: scanCount }),
    redis.scan('match:*', { count: scanCount }),
    redis.scan('contest_join:*', { count: scanCount })
  ]);

  const activeGameIdsFromServerMap = Array.isArray(matchServerKeys)
    ? matchServerKeys
      .map((key) => String(key || '').split(':'))
      .filter((parts) => parts.length >= 3)
      .map((parts) => parts[1])
      .filter(Boolean)
    : [];

  const activeGameIdsFromMatchKeys = Array.isArray(matchKeys)
    ? matchKeys
      .map((key) => String(key || ''))
      .filter((key) => key.startsWith('match:'))
      .map((key) => key.slice('match:'.length))
      .filter(Boolean)
    : [];

  const uniqueGameIds = [...new Set([...activeGameIdsFromServerMap, ...activeGameIdsFromMatchKeys])];
  const active_matches = [];
  for (const gameId of uniqueGameIds) {
    try {
      const match = await redis.get(`match:${gameId}`);
      if (match && typeof match === 'object') {
        active_matches.push({
          key: `match:${gameId}`,
          game_id: String(match.game_id || gameId),
          status: String(match.status || 'active'),
          user1_id: String(match.user1_id || ''),
          user2_id: String(match.user2_id || ''),
          turn: String(match.turn || ''),
          updated_at: String(match.updated_at || match.last_move_time || match.start_time || ''),
          details: match
        });
      }
    } catch (_) {
    }
  }

  const match_key_count = Array.isArray(matchKeys) ? matchKeys.filter((k) => String(k || '').startsWith('match:')).length : 0;
  const contest_joins = [];
  const contestKeys = Array.isArray(contestJoinKeys) ? contestJoinKeys : [];
  for (const key of contestKeys) {
    try {
      const parts = String(key || '').split(':');
      const value = await redis.get(String(key || ''));
      contest_joins.push({
        key: String(key || ''),
        user_id: String(value?.user_id || parts[1] || ''),
        contest_id: String(value?.contest_id || parts[2] || ''),
        l_id: String(value?.l_id || parts[3] || ''),
        league_id: String(value?.league_id || value?.LeagueID || ''),
        status: String(value?.status || ''),
        match_id: String(value?.match_id || value?.matchPairID || ''),
        joined_at: String(value?.joined_at || value?.joinedAt || ''),
        details: value && typeof value === 'object' ? value : { value: String(value || '') }
      });
    } catch (_) {
    }
  }

  return {
    redis_counts,
    server_id: serverId,
    active_game_count: uniqueGameIds.length,
    scanned_match_keys: match_key_count,
    active_matches,
    contest_joins
  };
}

async function getHistoricData({ page = 1, limit = 25, q = '' } = {}) {
  const [statusRows] = await mysqlClient.query(
    `SELECT status, COUNT(*) AS count
     FROM ludo_game
     WHERE is_deleted = 0
     GROUP BY status
     ORDER BY status`
  );

  const where = [
    `is_deleted = 0`,
    `status IN ('completed', 'expired', 'cancelled')`
  ];
  const params = [];
  const keyword = String(q || '').trim();
  if (keyword) {
    where.push(`(match_id LIKE ? OR CAST(user_id AS CHAR) LIKE ? OR CAST(opponent_user_id AS CHAR) LIKE ? OR CAST(contest_id AS CHAR) LIKE ?)`);
    const like = `%${keyword}%`;
    params.push(like, like, like, like);
  }

  const offset = (Math.max(1, Number(page)) - 1) * Math.max(1, Number(limit));
  const rowLimit = Math.max(1, Number(limit));

  const [countRows] = await mysqlClient.query(
    `SELECT COUNT(*) AS total FROM ludo_game WHERE ${where.join(' AND ')}`,
    params
  );

  const [historyRows] = await mysqlClient.query(
    `SELECT
       l_id, opponent_l_id, user_id, opponent_user_id, contest_id, match_id,
       status, contest_type, turn_id, winner_user_id, server_id, last_move_at,
       lock_version, joined_at, started_at, ended_at,
       status_id, league_id, move_count, s3_key, s3_etag, updated_at
     FROM ludo_game
     WHERE ${where.join(' AND ')}
     ORDER BY updated_at DESC
     LIMIT ? OFFSET ?`,
    [...params, rowLimit, offset]
  );

  return {
    status_counts: Array.isArray(statusRows) ? statusRows : [],
    recent_history: Array.isArray(historyRows) ? historyRows : [],
    total: Number((Array.isArray(countRows) && countRows[0] && countRows[0].total) || 0)
  };
}

async function runAdminTasks() {
  state.lastTickAt = new Date().toISOString();
  state.ticks += 1;
}

async function getOverview() {
  const [live, historic] = await Promise.all([
    getLiveData(),
    getHistoricData({ page: 1, limit: 10, q: '' })
  ]);
  return {
    timestamp: new Date().toISOString(),
    service: {
      started_at: state.startedAt,
      last_tick_at: state.lastTickAt,
      ticks: state.ticks,
      pid: process.pid
    },
    live,
    historic
  };
}

async function startAdminWeb() {
  if (adminServer) return;

  await loadPublicFiles();
  await loadAdminUsersFromS3();

  const port = Math.max(1, Number(process.env.ADMIN_PORT || 3099));
  const host = process.env.ADMIN_HOST || '0.0.0.0';

  adminServer = Fastify({ logger: false });

  adminServer.get('/health', async () => ({
    status: 'ok',
    timestamp: new Date().toISOString(),
    service: 'admin'
  }));

  adminServer.post('/api/login', async (request, reply) => {
    const username = String(request.body?.username || '').trim();
    const password = String(request.body?.password || '');

    const matchedUser = authConfig.users.find((u) => u.username === username && u.password === password);
    if (!matchedUser) {
      reply.code(401);
      return {
        status: 'error',
        message: 'invalid_credentials'
      };
    }

    const token = crypto.randomBytes(24).toString('hex');
    sessions.set(token, {
      username,
      created_at: Date.now(),
      expires_at: Date.now() + 24 * 60 * 60 * 1000
    });
    reply.header('Set-Cookie', buildSessionCookie(token));
    return {
      status: 'ok',
      username
    };
  });

  adminServer.post('/api/logout', async (request, reply) => {
    const token = getCookieValue(request?.headers?.cookie, 'admin_session');
    if (token) sessions.delete(token);
    reply.header('Set-Cookie', clearSessionCookie());
    return { status: 'ok' };
  });

  adminServer.get('/api/session', async (request, reply) => {
    const session = getSession(request);
    if (!session) {
      reply.code(401);
      return { authenticated: false };
    }
    return {
      authenticated: true,
      username: String(session.username || ''),
      can_manage_users: isEnvAdminUser(session.username),
      auth_source: authConfig.source
    };
  });

  adminServer.get('/api/users', async (request, reply) => {
    const username = getSessionUsername(request);
    if (!isEnvAdminUser(username)) {
      reply.code(403);
      return { status: 'error', message: 'forbidden' };
    }
    const envAdminUser = String(process.env.ADMIN_USERNAME || '').trim();
    return {
      status: 'ok',
      auth_source: authConfig.source,
      current_user: username,
      env_admin_user: envAdminUser,
      users: authConfig.users.map((u) => ({ username: String(u.username || '').trim() }))
    };
  });

  adminServer.post('/api/users', async (request, reply) => {
    const username = getSessionUsername(request);
    if (!isEnvAdminUser(username)) {
      reply.code(403);
      return { status: 'error', message: 'forbidden' };
    }
    const newUsername = String(request.body?.username || '').trim();
    const newPassword = String(request.body?.password || '');
    if (!newUsername || !newPassword) {
      reply.code(400);
      return { status: 'error', message: 'username_and_password_required' };
    }
    const exists = authConfig.users.some((u) => String(u.username || '').trim() === newUsername);
    if (exists) {
      reply.code(409);
      return { status: 'error', message: 'user_already_exists' };
    }
    authConfig.users.push({ username: newUsername, password: newPassword });
    await saveAdminUsersToS3();
    return { status: 'ok' };
  });

  adminServer.put('/api/users/:username/password', async (request, reply) => {
    const username = getSessionUsername(request);
    if (!isEnvAdminUser(username)) {
      reply.code(403);
      return { status: 'error', message: 'forbidden' };
    }
    const targetUsername = String(request.params?.username || '').trim();
    const newPassword = String(request.body?.password || '');
    if (!targetUsername || !newPassword) {
      reply.code(400);
      return { status: 'error', message: 'username_and_password_required' };
    }
    const idx = authConfig.users.findIndex((u) => String(u.username || '').trim() === targetUsername);
    if (idx < 0) {
      reply.code(404);
      return { status: 'error', message: 'user_not_found' };
    }
    authConfig.users[idx] = {
      username: targetUsername,
      password: newPassword
    };
    await saveAdminUsersToS3();
    return { status: 'ok' };
  });

  adminServer.delete('/api/users/:username', async (request, reply) => {
    const username = getSessionUsername(request);
    if (!isEnvAdminUser(username)) {
      reply.code(403);
      return { status: 'error', message: 'forbidden' };
    }

    const targetUsername = String(request.params?.username || '').trim();
    const envAdminUser = String(process.env.ADMIN_USERNAME || '').trim();
    if (!targetUsername) {
      reply.code(400);
      return { status: 'error', message: 'username_required' };
    }
    if (targetUsername === envAdminUser) {
      reply.code(400);
      return { status: 'error', message: 'cannot_delete_env_admin' };
    }

    const idx = authConfig.users.findIndex((u) => String(u.username || '').trim() === targetUsername);
    if (idx < 0) {
      reply.code(404);
      return { status: 'error', message: 'user_not_found' };
    }

    authConfig.users.splice(idx, 1);
    await saveAdminUsersToS3();
    return { status: 'ok' };
  });

  adminServer.addHook('onRequest', async (request, reply) => {
    const p = String(request.routerPath || request.url || '');
    const openPaths = new Set([
      '/health',
      '/login',
      '/api/login',
      '/api/session',
      '/assets/style.css',
      '/assets/app.js'
    ]);
    if (openPaths.has(p)) return;

    if (!isAuthenticated(request)) {
      if (p.startsWith('/api/')) {
        reply.code(401).send({
          status: 'error',
          message: 'unauthorized'
        });
        return reply;
      }
      reply.redirect('/login');
      return reply;
    }

    if (p === '/login') {
      reply.redirect('/dashboard');
      return reply;
    }

    if (p === '/users') {
      const username = getSessionUsername(request);
      if (!isEnvAdminUser(username)) {
        reply.redirect('/dashboard');
        return reply;
      }
    }
    return undefined;
  });

  adminServer.get('/api/overview', async (request, reply) => {
    try {
      return await getOverview();
    } catch (err) {
      reply.code(500);
      return {
        status: 'error',
        message: err?.message || 'failed_to_build_overview'
      };
    }
  });

  adminServer.get('/api/live', async (request, reply) => {
    try {
      const page = Math.max(1, Number(request.query?.page || 1));
      const limit = Math.max(1, Number(request.query?.limit || 25));
      const q = String(request.query?.q || '').trim();
      const kind = String(request.query?.kind || 'match').trim().toLowerCase();
      const live = await getLiveData();
      const sourceRows = kind === 'contest_join'
        ? (Array.isArray(live.contest_joins) ? live.contest_joins : [])
        : (Array.isArray(live.active_matches) ? live.active_matches : []);
      const filtered = q
        ? sourceRows.filter((row) => {
          const s = Object.values(row || {}).join(' ').toLowerCase();
          return s.includes(q.toLowerCase());
        })
        : sourceRows;
      const offset = (page - 1) * limit;
      const items = filtered.slice(offset, offset + limit);
      return {
        timestamp: new Date().toISOString(),
        ...live,
        kind,
        items,
        total: filtered.length,
        page,
        limit
      };
    } catch (err) {
      reply.code(500);
      return {
        status: 'error',
        message: err?.message || 'failed_to_build_live_data'
      };
    }
  });

  adminServer.get('/api/historic', async (request, reply) => {
    try {
      const page = Math.max(1, Number(request.query?.page || 1));
      const limit = Math.max(1, Number(request.query?.limit || 25));
      const q = String(request.query?.q || '').trim();
      const historic = await getHistoricData({ page, limit, q });
      return {
        timestamp: new Date().toISOString(),
        status_counts: historic.status_counts,
        items: historic.recent_history,
        total: historic.total,
        page,
        limit
      };
    } catch (err) {
      reply.code(500);
      return {
        status: 'error',
        message: err?.message || 'failed_to_build_historic_data'
      };
    }
  });

  async function deleteHistoricByLid(lIdRaw) {
    const lId = String(lIdRaw || '').trim();
    if (!lId) {
      return { code: 400, body: { status: 'error', message: 'l_id_required' } };
    }
    const [result] = await mysqlClient.query(
      `UPDATE ludo_game
       SET is_deleted = 1, updated_at = NOW(3)
       WHERE l_id = ? AND is_deleted = 0`,
      [lId]
    );
    const affected = Number(result?.affectedRows || 0);
    if (affected <= 0) {
      return { code: 404, body: { status: 'error', message: 'row_not_found_or_already_deleted' } };
    }
    return { code: 200, body: { status: 'ok', l_id: lId, deleted: affected } };
  }

  async function resendMatchFinalizeByMatchId(matchIdRaw) {
    const matchId = String(matchIdRaw || '').trim();
    if (!matchId) {
      return { code: 400, body: { status: 'error', message: 'match_id_required' } };
    }

    const [rows] = await mysqlClient.query(
      `SELECT
         match_id,
         user_id,
         opponent_user_id,
         winner_user_id,
         contest_id,
         gameModeId,
         gameHistoryId,
         updated_at
       FROM ludo_game
       WHERE is_deleted = 0 AND match_id = ?
       ORDER BY updated_at DESC`,
      [matchId]
    );
    const list = Array.isArray(rows) ? rows : [];
    if (list.length === 0) {
      return { code: 404, body: { status: 'error', message: 'match_not_found' } };
    }

    const uniqPlayers = [];
    const addPlayer = (value) => {
      const normalized = String(value || '').trim();
      if (!normalized) return;
      if (uniqPlayers.includes(normalized)) return;
      uniqPlayers.push(normalized);
    };
    list.forEach((row) => {
      addPlayer(row?.user_id);
      addPlayer(row?.opponent_user_id);
    });
    if (uniqPlayers.length < 2) {
      return { code: 400, body: { status: 'error', message: 'players_not_resolvable' } };
    }

    const winnerUserId = String(list.find((r) => String(r?.winner_user_id || '').trim())?.winner_user_id || '').trim();
    if (!winnerUserId) {
      return { code: 400, body: { status: 'error', message: 'winner_not_found_for_match' } };
    }
    if (!uniqPlayers.includes(winnerUserId)) {
      return { code: 400, body: { status: 'error', message: 'winner_not_in_players' } };
    }

    const loserUserId = uniqPlayers.find((id) => id !== winnerUserId) || '';
    if (!loserUserId) {
      return { code: 400, body: { status: 'error', message: 'loser_not_found_for_match' } };
    }

    const winnerRow = list.find((row) => String(row?.user_id || '').trim() === winnerUserId) || null;
    const loserRow = list.find((row) => String(row?.user_id || '').trim() === loserUserId) || null;
    const gameModeRaw = winnerRow?.gameModeId ?? loserRow?.gameModeId ?? list[0]?.gameModeId ?? '';
    const gameHistoryId = String(winnerRow?.gameHistoryId || loserRow?.gameHistoryId || list[0]?.gameHistoryId || '').trim();
    const gameModeId = Number.isFinite(Number(gameModeRaw)) ? Number(gameModeRaw) : Number(process.env.MATCH_FINALIZE_API_DEFAULT_GAME_MODE_ID || 1);
    const gameId = String(process.env.MATCH_FINALIZE_API_GAME_ID || '1').trim() || '1';

    const baseUrl = String(process.env.MATCH_FINALIZE_API_BASE_URL || '').trim();
    const endpoint = String(process.env.MATCH_FINALIZE_API_ENDPOINT || '').trim();
    const gameMatchKey = String(process.env.MATCH_FINALIZE_API_GAME_MATCH_KEY || '').trim();
    const timeout = Number(process.env.MATCH_FINALIZE_API_TIMEOUT_MS || 5000);
    if (!baseUrl || !endpoint || !gameMatchKey) {
      return { code: 400, body: { status: 'error', message: 'match_finalize_api_not_configured' } };
    }

    const normalizedBaseUrl = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
    const normalizedEndpoint = endpoint.startsWith('/') ? endpoint : `/${endpoint}`;
    const url = `${normalizedBaseUrl}${normalizedEndpoint}`;

    const payload = {
      gameHistoryId,
      gameId,
      gameModeId: Number.isFinite(gameModeId) ? gameModeId : 1,
      winnerUserId: Number(winnerUserId),
      players: [
        { userId: Number(winnerUserId), result: 'win', score: 100 },
        { userId: Number(loserUserId), result: 'lose', score: 0 }
      ]
    };

    try {
      const response = await axios.post(url, payload, {
        headers: {
          'Content-Type': 'application/json',
          'X-Game-Match-Key': gameMatchKey
        },
        timeout: Number.isFinite(timeout) && timeout > 0 ? timeout : 5000
      });
      return {
        code: 200,
        body: {
          status: 'ok',
          message: 'match_finalize_api_called',
          match_id: matchId,
          winner_user_id: winnerUserId,
          loser_user_id: loserUserId,
          payload,
          api_status: response?.status || 200,
          api_response: response?.data || null
        }
      };
    } catch (error) {
      const statusCode = Number(error?.response?.status || 500);
      return {
        code: statusCode,
        body: {
          status: 'error',
          message: error?.message || 'match_finalize_api_failed',
          match_id: matchId,
          payload,
          api_status: error?.response?.status || null,
          api_response: error?.response?.data || null
        }
      };
    }
  }

  adminServer.delete('/api/historic/:lid', async (request, reply) => {
    try {
      const result = await deleteHistoricByLid(request.params?.lid);
      reply.code(result.code);
      return result.body;
    } catch (err) {
      reply.code(500);
      return {
        status: 'error',
        message: err?.message || 'failed_to_delete_historic_row'
      };
    }
  });

  adminServer.post('/api/historic/delete/:lid', async (request, reply) => {
    try {
      const result = await deleteHistoricByLid(request.params?.lid);
      reply.code(result.code);
      return result.body;
    } catch (err) {
      reply.code(500);
      return {
        status: 'error',
        message: err?.message || 'failed_to_delete_historic_row'
      };
    }
  });

  adminServer.post('/api/historic/:matchId/finalize', async (request, reply) => {
    try {
      const result = await resendMatchFinalizeByMatchId(request.params?.matchId);
      reply.code(result.code);
      return result.body;
    } catch (err) {
      reply.code(500);
      return {
        status: 'error',
        message: err?.message || 'failed_to_finalize_match'
      };
    }
  });

  adminServer.get('/api/historic/:matchId/state', async (request, reply) => {
    try {
      const matchId = String(request.params?.matchId || '').trim();
      if (!matchId) {
        reply.code(400);
        return { status: 'error', message: 'match_id_required' };
      }

      const [rows] = await mysqlClient.query(
        `SELECT match_id, status, s3_key, updated_at
         FROM ludo_game
         WHERE is_deleted = 0 AND match_id = ?
         ORDER BY updated_at DESC
         LIMIT 1`,
        [matchId]
      );

      const row = Array.isArray(rows) && rows[0] ? rows[0] : null;
      if (!row) {
        reply.code(404);
        return { status: 'error', message: 'match_not_found' };
      }

      const s3Key = String(row.s3_key || '').trim();
      if (!s3Key) {
        reply.code(404);
        return { status: 'error', message: 's3_key_not_found_for_match' };
      }

      const s3State = await getGameStateJson(s3Key);
      return {
        status: 'ok',
        match_id: String(row.match_id || ''),
        s3_key: s3Key,
        updated_at: row.updated_at || null,
        s3_state: s3State
      };
    } catch (err) {
      reply.code(500);
      return {
        status: 'error',
        message: err?.message || 'failed_to_load_s3_state'
      };
    }
  });

  adminServer.get('/login', async (request, reply) => {
    reply.type('text/html').send(publicFiles.loginHtml);
  });

  adminServer.get('/dashboard', async (request, reply) => {
    reply.type('text/html').send(publicFiles.dashboardHtml);
  });

  adminServer.get('/live', async (request, reply) => {
    reply.type('text/html').send(publicFiles.liveHtml);
  });

  adminServer.get('/history', async (request, reply) => {
    reply.type('text/html').send(publicFiles.historyHtml);
  });

  adminServer.get('/users', async (request, reply) => {
    reply.type('text/html').send(publicFiles.usersHtml);
  });

  adminServer.get('/assets/style.css', async (request, reply) => {
    reply.type('text/css').send(publicFiles.css);
  });

  adminServer.get('/assets/app.js', async (request, reply) => {
    reply.type('application/javascript').send(publicFiles.js);
  });

  adminServer.get('/', async (request, reply) => {
    if (isAuthenticated(request)) {
      reply.redirect('/dashboard');
      return;
    }
    reply.redirect('/login');
  });

  await adminServer.listen({ port, host });
  console.log(`[Admin] web started on http://${host}:${port}`);
}

async function initializeAdminService() {
  if (isRunning) return;

  try {
    await mysqlClient;
  } catch (error) {
    console.error('[Admin] mysql not connected at startup:', error?.message || error);
  }
  await startAdminWeb();

  const tickMs = Math.max(1000, Number(process.env.ADMIN_TICK_MS || 30000));

  adminIntervalId = setInterval(() => {
    runAdminTasks().catch(() => {});
  }, tickMs);

  state.startedAt = new Date().toISOString();
  runAdminTasks().catch(() => {});

  isRunning = true;
  console.log(`[Admin] service started (tick=${tickMs}ms)`);
}

async function stopAdminService() {
  if (!isRunning) return;
  if (adminIntervalId) {
    clearInterval(adminIntervalId);
    adminIntervalId = null;
  }
  if (adminServer) {
    try {
      await adminServer.close();
    } catch (_) {
    }
    adminServer = null;
  }
  isRunning = false;
  console.log('[Admin] service stopped');
}

module.exports = {
  initializeAdminService,
  stopAdminService
};
