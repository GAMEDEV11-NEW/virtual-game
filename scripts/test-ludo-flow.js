require('dotenv').config();

const { io } = require('socket.io-client');

const SOCKET_URL = process.env.SOCKET_TEST_URL || 'http://127.0.0.1:3016';
const USER_ID = String(process.env.SOCKET_TEST_USER_ID || '1234');
const CONTEST_ID = String(process.env.SOCKET_TEST_CONTEST_ID || '9');
const L_ID = String(process.env.SOCKET_TEST_L_ID || `lj_${USER_ID}_${CONTEST_ID}_${Date.now()}`);
const GAME_ID = String(process.env.SOCKET_TEST_GAME_ID || '');
const TIMEOUT_MS = Number(process.env.SOCKET_TEST_TIMEOUT_MS || 15000);
const MATCH_WAIT_MS = Number(process.env.SOCKET_TEST_MATCH_WAIT_MS || 60000);
const MATCH_POLL_INTERVAL_MS = Number(process.env.SOCKET_TEST_MATCH_POLL_INTERVAL_MS || 2000);
const CONNECT_RETRIES = Number(process.env.SOCKET_TEST_CONNECT_RETRIES || 5);
const CONNECT_RETRY_DELAY_MS = Number(process.env.SOCKET_TEST_CONNECT_RETRY_DELAY_MS || 2000);

const RUN_DICE = String(process.env.SOCKET_TEST_RUN_DICE || 'false').toLowerCase() === 'true';
const RUN_PIECE_MOVE = String(process.env.SOCKET_TEST_RUN_PIECE_MOVE || 'false').toLowerCase() === 'true';
const AUTO_PICK_PIECE_MOVE = String(process.env.SOCKET_TEST_AUTO_PICK_PIECE_MOVE || 'true').toLowerCase() === 'true';

const PIECE_ID = String(process.env.SOCKET_TEST_PIECE_ID || '');
const PIECE_TYPE = String(process.env.SOCKET_TEST_PIECE_TYPE || 'piece_1');
const FROM_POS = String(process.env.SOCKET_TEST_FROM_POS || 'initial');
const TO_POS = String(process.env.SOCKET_TEST_TO_POS || '1');
const DICE_NUMBER = Number(process.env.SOCKET_TEST_DICE_NUMBER || 6);

const SESSION_TOKEN = process.env.SOCKET_TEST_SESSION_TOKEN || '';
const DEVICE_ID = process.env.SOCKET_TEST_DEVICE_ID || '';
const JWT_TOKEN = process.env.SOCKET_TEST_JWT_TOKEN || '';

function now() {
  return new Date().toISOString();
}

function printEvent(name, data) {
  console.log(`[${now()}] ${name} -> ${JSON.stringify(data)}`);
}

function waitForEvent(socket, eventName, timeoutMs = TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(eventName, onEvent);
      reject(new Error(`timeout waiting for ${eventName}`));
    }, timeoutMs);

    function onEvent(payload) {
      clearTimeout(timer);
      socket.off(eventName, onEvent);
      resolve(payload);
    }

    socket.on(eventName, onEvent);
  });
}

async function requestOpponentUntilReady(socket, payload) {
  const startedAt = Date.now();
  let lastResponse = null;

  while (Date.now() - startedAt <= MATCH_WAIT_MS) {
    printEvent('emit check:opponent', payload);
    socket.emit('check:opponent', payload);
    const res = await waitForEvent(socket, 'opponent:response');
    printEvent('opponent:response', res);
    lastResponse = res;

    const status = String(res?.status || '').toLowerCase();
    const gameId = String(res?.game_id || '');
    if (status === 'success' && gameId) {
      return res;
    }

    if (status === 'expired' || status === 'completed') {
      return res;
    }

    await new Promise((resolve) => setTimeout(resolve, MATCH_POLL_INTERVAL_MS));
  }

  return lastResponse;
}

function toNumPos(pos) {
  if (pos === null || pos === undefined) return null;
  if (pos === 'initial' || pos === 'goal' || pos === 'finished') return null;
  const n = Number(pos);
  return Number.isFinite(n) ? n : null;
}

function getMyPiecesFromMatchState(matchStateResponse, userId) {
  const st = matchStateResponse?.match_state || {};
  const user1Id = String(st.user1_id || '');
  const user2Id = String(st.user2_id || '');
  if (String(userId) === user1Id) return Array.isArray(st.user1_pieces) ? st.user1_pieces : [];
  if (String(userId) === user2Id) return Array.isArray(st.user2_pieces) ? st.user2_pieces : [];
  return [];
}

function chooseAutoPieceMove(matchStateResponse, userId, diceNumber) {
  const pieces = getMyPiecesFromMatchState(matchStateResponse, userId);
  if (!pieces.length || !Number.isFinite(Number(diceNumber))) return null;
  const dice = Number(diceNumber);

  if (dice === 6) {
    const homePiece = pieces.find((p) => String(p?.to_pos_last || p?.from_pos_last || '') === 'initial');
    if (homePiece) {
      return {
        piece_id: String(homePiece.piece_id || homePiece.id || ''),
        piece_type: String(homePiece.piece_type || 'piece_1'),
        from_pos_last: 'initial',
        to_pos_last: '1',
        dice_number: 6
      };
    }
  }

  for (const p of pieces) {
    const fromRaw = p?.to_pos_last ?? p?.from_pos_last;
    const fromNum = toNumPos(fromRaw);
    if (fromNum === null) continue;
    const toNum = fromNum + dice;
    if (toNum <= 57) {
      return {
        piece_id: String(p.piece_id || p.id || ''),
        piece_type: String(p.piece_type || 'piece_1'),
        from_pos_last: String(fromNum),
        to_pos_last: String(toNum),
        dice_number: dice
      };
    }
  }

  return null;
}

async function connectWithRetry() {
  let lastErr = null;

  for (let attempt = 1; attempt <= Math.max(1, CONNECT_RETRIES); attempt++) {
    const socket = io(SOCKET_URL, {
      transports: ['websocket'],
      timeout: TIMEOUT_MS,
      auth: {
        user_id: USER_ID,
        contest_id: CONTEST_ID,
        l_id: L_ID
      }
    });

    try {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('socket connect timeout')), TIMEOUT_MS);
        socket.once('connect', () => {
          clearTimeout(timer);
          resolve();
        });
        socket.once('connect_error', (err) => {
          clearTimeout(timer);
          reject(err || new Error('connect_error'));
        });
      });
      return socket;
    } catch (err) {
      lastErr = err;
      try {
        socket.close();
      } catch (_) {
      }
      console.error(`[${now()}] connect_attempt_failed=${attempt}/${CONNECT_RETRIES} message=${err?.message || err}`);
      if (attempt < CONNECT_RETRIES) {
        await new Promise((resolve) => setTimeout(resolve, CONNECT_RETRY_DELAY_MS));
      }
    }
  }

  throw lastErr || new Error('socket connect failed');
}

async function main() {
  const socket = await connectWithRetry();

  socket.on('connect_error', (err) => {
    console.error(`[${now()}] connect_error=${err?.message || err}`);
  });
  socket.on('connection:established', (data) => printEvent('connection:established', data));
  socket.on('opponent:move:update', (data) => printEvent('opponent:move:update', data));
  socket.on('game:won', (data) => printEvent('game:won', data));
  socket.on('game:lost', (data) => printEvent('game:lost', data));
  socket.on('stop:timer_updates', (data) => printEvent('stop:timer_updates', data));

  console.log(`[${now()}] connected socket_id=${socket.id} user_id=${USER_ID} contest_id=${CONTEST_ID} l_id=${L_ID}`);

  // 1) check:opponent (poll until matched/success or timeout)
  const opponentPayload = { user_id: USER_ID, contest_id: CONTEST_ID, l_id: L_ID };
  const opponentRes = await requestOpponentUntilReady(socket, opponentPayload);
  const opponentStatus = String(opponentRes?.status || '').toLowerCase();
  if (opponentStatus === 'completed' || opponentStatus === 'expired') {
    console.log(`[${now()}] terminal_opponent_status=${opponentStatus} skipping_match_state=true`);
    socket.close();
    process.exit(0);
  }

  const resolvedGameId = String(opponentRes?.game_id || GAME_ID || '');
  if (!resolvedGameId) {
    console.log(`[${now()}] no_game_id_from_opponent_response=true status=${String(opponentRes?.status || '')}`);
    socket.close();
    process.exit(0);
  }

  // 2) get:match_state
  const matchStatePayload = {
    game_id: resolvedGameId,
    contest_id: CONTEST_ID,
    l_id: L_ID,
    user_id: USER_ID
  };
  printEvent('emit get:match_state', matchStatePayload);
  socket.emit('get:match_state', matchStatePayload);
  const matchStateRes = await waitForEvent(socket, 'get:match_state:response');
  printEvent('get:match_state:response', matchStateRes);

  // 3) dice:roll (optional)
  let diceRes = null;
  if (RUN_DICE) {
    const dicePayload = {
      game_id: resolvedGameId,
      contest_id: CONTEST_ID,
      l_id: L_ID,
      user_id: USER_ID,
      session_token: SESSION_TOKEN,
      device_id: DEVICE_ID,
      jwt_token: JWT_TOKEN
    };
    printEvent('emit dice:roll', dicePayload);
    socket.emit('dice:roll', dicePayload);
    diceRes = await waitForEvent(socket, 'dice:roll:response');
    printEvent('dice:roll:response', diceRes);
  }

  // 4) piece:move (optional)
  if (RUN_PIECE_MOVE) {
    let pieceMovePayload = null;

    if (AUTO_PICK_PIECE_MOVE) {
      const autoMove = chooseAutoPieceMove(matchStateRes, USER_ID, Number(diceRes?.dice_number || DICE_NUMBER));
      if (autoMove && autoMove.piece_id) {
        pieceMovePayload = {
          game_id: resolvedGameId,
          contest_id: CONTEST_ID,
          l_id: L_ID,
          user_id: USER_ID,
          piece_id: autoMove.piece_id,
          piece_type: autoMove.piece_type,
          from_pos_last: autoMove.from_pos_last,
          to_pos_last: autoMove.to_pos_last,
          dice_number: autoMove.dice_number
        };
      }
    }

    if (!pieceMovePayload) {
      pieceMovePayload = {
        game_id: resolvedGameId,
        contest_id: CONTEST_ID,
        l_id: L_ID,
        user_id: USER_ID,
        piece_id: PIECE_ID,
        piece_type: PIECE_TYPE,
        from_pos_last: FROM_POS,
        to_pos_last: TO_POS,
        dice_number: DICE_NUMBER
      };
    }

    printEvent('emit piece:move', pieceMovePayload);
    socket.emit('piece:move', pieceMovePayload);
    const pieceRes = await waitForEvent(socket, 'piece:move:response');
    printEvent('piece:move:response', pieceRes);
  }

  socket.close();
  console.log(`[${now()}] flow_test_done=true`);
  process.exit(0);
}

main().catch((err) => {
  console.error(`[${now()}] flow_test_error=${err?.message || err}`);
  process.exit(1);
});
