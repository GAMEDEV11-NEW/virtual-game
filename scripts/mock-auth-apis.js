require('dotenv').config();

const http = require('http');
const { URL } = require('url');

const PORT = Number(process.env.MOCK_APIS_PORT || 8090);
const HOST = process.env.MOCK_APIS_HOST || '127.0.0.1';

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body)
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (_) {
        resolve({});
      }
    });
    req.on('error', () => resolve({}));
  });
}

function getPathUserId(pathname, prefix) {
  if (!pathname.startsWith(prefix)) return '';
  return decodeURIComponent(pathname.slice(prefix.length));
}

function buildSession(userId) {
  const now = new Date().toISOString();
  return {
    user_id: String(userId),
    is_active: true,
    session_token: `mock-session-${userId}`,
    device_id: 'mock-device',
    socket_id: '',
    updated_at: now,
    expires_at: '2099-12-31T23:59:59.000Z'
  };
}

function buildContestJoin(userId, contestId) {
  const now = new Date().toISOString();
  return {
    user_id: String(userId),
    contest_id: String(contestId || '9'),
    league_id: String(contestId || '9'),
    l_id: `lj_${userId}_${contestId || '9'}`,
    game_type: 'ludo',
    contest_type: 'simple',
    joined_at: now,
    status: 'pending',
    status_id: '1',
    opponent_user_id: '',
    opponent_league_id: '',
    match_pair_id: '',
    turn_id: null,
    extra_data: null
  };
}

const server = http.createServer(async (req, res) => {
  const parsed = new URL(req.url, `http://${req.headers.host}`);
  const { pathname, searchParams } = parsed;
  const method = req.method || 'GET';

  if (method === 'GET' && pathname.startsWith('/sessions/')) {
    const userId = getPathUserId(pathname, '/sessions/');
    return sendJson(res, 200, { session: buildSession(userId) });
  }

  if (method === 'POST' && pathname === '/sessions/get') {
    const body = await readBody(req);
    const userId = body.user_id || '1001';
    return sendJson(res, 200, { session: buildSession(userId) });
  }

  if (method === 'GET' && pathname.startsWith('/contest-join/')) {
    const userId = getPathUserId(pathname, '/contest-join/');
    const contestId = searchParams.get('contest_id') || '9';
    return sendJson(res, 200, { contest_join: buildContestJoin(userId, contestId) });
  }

  if (method === 'POST' && pathname === '/contest-join') {
    const body = await readBody(req);
    const userId = body.user_id || '1001';
    const contestId = body.contest_id || '9';
    return sendJson(res, 200, { contest_join: buildContestJoin(userId, contestId) });
  }

  return sendJson(res, 404, { error: 'not_found' });
});

server.listen(PORT, HOST, () => {
  console.log(`mock_apis_running=http://${HOST}:${PORT}`);
  console.log('endpoints: GET /sessions/:userId, POST /sessions/get, GET /contest-join/:userId, POST /contest-join');
});
