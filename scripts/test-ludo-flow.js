require('dotenv').config();

const { io } = require('socket.io-client');

const CFG = {
  socketUrl: process.env.SOCKET_TEST_URL || 'http://127.0.0.1:3016',
  userId: String(process.env.SOCKET_TEST_USER_ID || '1234'),
  secondUserId: String(process.env.SOCKET_TEST_SECOND_USER_ID || '789'),
  contestId: String(process.env.SOCKET_TEST_CONTEST_ID || '9'),
  lId: String(process.env.SOCKET_TEST_L_ID || `lj_${Date.now()}`),
  secondLId: String(process.env.SOCKET_TEST_SECOND_L_ID || `lj2_${Date.now()}`),
  timeoutMs: Number(process.env.SOCKET_TEST_TIMEOUT_MS || 15000),
  matchWaitMs: Number(process.env.SOCKET_TEST_MATCH_WAIT_MS || 60000),
  pollMs: Number(process.env.SOCKET_TEST_MATCH_POLL_INTERVAL_MS || 2000),
  connectRetries: Number(process.env.SOCKET_TEST_CONNECT_RETRIES || 5),
  connectRetryDelayMs: Number(process.env.SOCKET_TEST_CONNECT_RETRY_DELAY_MS || 2000),
  runDice: String(process.env.SOCKET_TEST_RUN_DICE || 'true').toLowerCase() === 'true',
  runPieceMove: String(process.env.SOCKET_TEST_RUN_PIECE_MOVE || 'true').toLowerCase() === 'true',
  fullGame: String(process.env.SOCKET_TEST_FULL_GAME || 'false').toLowerCase() === 'true',
  maxTurns: Number(process.env.SOCKET_TEST_MAX_TURNS || 300)
};

function ts() {
  return new Date().toISOString();
}

function log(msg, obj) {
  if (obj === undefined) {
    console.log(`[${ts()}] ${msg}`);
    return;
  }
  console.log(`[${ts()}] ${msg} ${JSON.stringify(obj)}`);
}

function fail(step, message, data) {
  console.error(`[${ts()}] FAIL ${step}: ${message}`);
  if (data !== undefined) console.error(JSON.stringify(data));
  process.exit(1);
}

function pass(step, data) {
  log(`PASS ${step}`, data);
}

function sameId(a, b) {
  return String(a || '') === String(b || '');
}

function toNum(pos) {
  const n = Number(pos);
  return Number.isFinite(n) ? n : null;
}

function waitForEvent(socket, eventName, timeoutMs) {
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

async function connectWithRetry(userId, lId) {
  let lastErr = null;

  for (let attempt = 1; attempt <= Math.max(1, CFG.connectRetries); attempt++) {
    const socket = io(CFG.socketUrl, {
      transports: ['websocket'],
      timeout: CFG.timeoutMs,
      auth: {
        user_id: userId,
        contest_id: CFG.contestId,
        l_id: lId
      }
    });

    socket.on('connect_error', (err) => log('connect_error', { user_id: userId, message: err?.message || String(err) }));

    try {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('connect timeout')), CFG.timeoutMs);
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
      } catch (_) {}
      log('connect_attempt_failed', { user_id: userId, attempt, max: CFG.connectRetries, message: err?.message || String(err) });
      if (attempt < CFG.connectRetries) {
        await new Promise((r) => setTimeout(r, CFG.connectRetryDelayMs));
      }
    }
  }

  throw lastErr || new Error('socket connect failed');
}

async function emitAndWait(socket, requestEvent, responseEvent, payload, stepName) {
  log(`STEP ${stepName} request`, payload);
  socket.emit(requestEvent, payload);
  const res = await waitForEvent(socket, responseEvent, CFG.timeoutMs).catch((e) => fail(stepName, e.message));
  log(`STEP ${stepName} response`, res);
  return res;
}

async function pollOpponentUntilReady(socket, userId, lId) {
  const started = Date.now();
  let last = null;

  while (Date.now() - started <= CFG.matchWaitMs) {
    const req = { user_id: userId, contest_id: CFG.contestId, l_id: lId };
    const res = await emitAndWait(socket, 'check:opponent', 'opponent:response', req, `check:opponent(${userId})`);
    last = res;
    const status = String(res?.status || '').toLowerCase();
    if (status === 'success' || status === 'expired' || status === 'completed') {
      return res;
    }
    await new Promise((r) => setTimeout(r, CFG.pollMs));
  }

  return last;
}

async function getMatchState(socket, userId, lId, gameId) {
  return emitAndWait(
    socket,
    'get:match_state',
    'get:match_state:response',
    { game_id: gameId, contest_id: CFG.contestId, l_id: lId, user_id: userId },
    `get:match_state(${userId})`
  );
}

function chooseMoveFromState(matchState, userId, diceNumber) {
  const st = matchState?.match_state || {};
  const isUser1 = sameId(st.user1_id, userId);
  const myPieces = isUser1 ? (st.user1_pieces || []) : (st.user2_pieces || []);
  const dice = Number(diceNumber);
  if (!Number.isFinite(dice) || !myPieces.length) return null;

  if (dice === 6) {
    const home = myPieces.find((p) => String(p.to_pos_last || p.from_pos_last) === 'initial');
    if (home) {
      return {
        piece_id: String(home.piece_id || home.id || ''),
        piece_type: String(home.piece_type || 'piece_1'),
        from_pos_last: 'initial',
        to_pos_last: '1',
        dice_number: 6
      };
    }
  }

  for (const p of myPieces) {
    const fromRaw = p.to_pos_last ?? p.from_pos_last;
    const from = toNum(fromRaw);
    if (from === null) continue;
    const to = from + dice;
    if (to <= 57) {
      return {
        piece_id: String(p.piece_id || p.id || ''),
        piece_type: String(p.piece_type || 'piece_1'),
        from_pos_last: String(from),
        to_pos_last: String(to),
        dice_number: dice
      };
    }
  }

  return null;
}

async function runSingleUserFlow() {
  const socket = await connectWithRetry(CFG.userId, CFG.lId).catch((e) => fail('connect', e.message));
  pass('connect', { socket_id: socket.id, user_id: CFG.userId, contest_id: CFG.contestId, l_id: CFG.lId });

  const opponentRes = await pollOpponentUntilReady(socket, CFG.userId, CFG.lId);
  const status = String(opponentRes?.status || '').toLowerCase();
  if (status === 'expired' || status === 'completed') {
    pass('check:opponent-terminal', { status, game_id: opponentRes?.game_id || '' });
    socket.close();
    pass('flow-complete');
    process.exit(0);
  }

  if (status !== 'success' || !opponentRes?.game_id) {
    fail('check:opponent', 'did not reach success with game_id', opponentRes);
  }
  const gameId = String(opponentRes.game_id);
  pass('check:opponent-success', { game_id: gameId, turn_id: opponentRes.turn_id });

  const matchRes = await getMatchState(socket, CFG.userId, CFG.lId, gameId);
  if (String(matchRes?.status || '').toLowerCase() !== 'success') {
    fail('get:match_state', 'non-success response', matchRes);
  }
  pass('get:match_state', { game_id: matchRes.game_id, turn: matchRes?.match_state?.turn });

  let diceRes = null;
  if (CFG.runDice) {
    diceRes = await emitAndWait(
      socket,
      'dice:roll',
      'dice:roll:response',
      {
        game_id: gameId,
        contest_id: CFG.contestId,
        l_id: CFG.lId,
        user_id: CFG.userId,
        session_token: process.env.SOCKET_TEST_SESSION_TOKEN || '',
        device_id: process.env.SOCKET_TEST_DEVICE_ID || '',
        jwt_token: process.env.SOCKET_TEST_JWT_TOKEN || ''
      },
      `dice:roll(${CFG.userId})`
    );
    if (diceRes?.success === false || String(diceRes?.status || '').toLowerCase() === 'error') {
      fail('dice:roll', 'error response', diceRes);
    }
    pass('dice:roll', { dice_number: Number(diceRes?.dice_number), turn: diceRes?.turn });
  }

  if (CFG.runPieceMove) {
    const latest = await getMatchState(socket, CFG.userId, CFG.lId, gameId);
    if (String(latest?.status || '').toLowerCase() !== 'success') {
      fail('piece:move', 'latest match state is not success', latest);
    }

    const latestTurn = String(latest?.match_state?.turn || '');
    if (latestTurn && !sameId(latestTurn, CFG.userId)) {
      pass('piece:move-skip', { reason: 'not_your_turn_after_dice', turn: latestTurn, user_id: CFG.userId });
      pass('flow-complete');
      socket.close();
      process.exit(0);
    }

    const chosen = chooseMoveFromState(latest, CFG.userId, Number(diceRes?.dice_number || 6));
    if (!chosen || !chosen.piece_id) {
      pass('piece:move-skip', { reason: 'no_legal_auto_move_for_current_dice', dice_number: Number(diceRes?.dice_number || 6) });
      pass('flow-complete');
      socket.close();
      process.exit(0);
    }

    const moveRes = await emitAndWait(
      socket,
      'piece:move',
      'piece:move:response',
      {
        game_id: gameId,
        contest_id: CFG.contestId,
        l_id: CFG.lId,
        user_id: CFG.userId,
        piece_id: chosen.piece_id,
        piece_type: chosen.piece_type,
        from_pos_last: chosen.from_pos_last,
        to_pos_last: chosen.to_pos_last,
        dice_number: chosen.dice_number
      },
      `piece:move(${CFG.userId})`
    );
    if (moveRes?.success === false || String(moveRes?.status || '').toLowerCase() === 'error') {
      fail('piece:move', 'error response', moveRes);
    }
    pass('piece:move', { turn: moveRes.turn, game_won: !!moveRes.game_won });
  }

  pass('flow-complete');
  socket.close();
  process.exit(0);
}

async function runFullGameFlow() {
  const a = { userId: CFG.userId, lId: CFG.lId };
  const b = { userId: CFG.secondUserId, lId: CFG.secondLId };

  a.socket = await connectWithRetry(a.userId, a.lId).catch((e) => fail('connect-user1', e.message));
  b.socket = await connectWithRetry(b.userId, b.lId).catch((e) => fail('connect-user2', e.message));
  pass('connect-both', {
    user1: { user_id: a.userId, socket_id: a.socket.id, l_id: a.lId },
    user2: { user_id: b.userId, socket_id: b.socket.id, l_id: b.lId }
  });

  const [opA, opB] = await Promise.all([
    pollOpponentUntilReady(a.socket, a.userId, a.lId),
    pollOpponentUntilReady(b.socket, b.userId, b.lId)
  ]);

  const stA = String(opA?.status || '').toLowerCase();
  const stB = String(opB?.status || '').toLowerCase();
  if (stA !== 'success' || stB !== 'success') {
    fail('check:opponent-both', 'both users did not reach success', { user1: opA, user2: opB });
  }
  const gameA = String(opA?.game_id || '');
  const gameB = String(opB?.game_id || '');
  if (!gameA || !gameB || gameA !== gameB) {
    fail('check:opponent-both', 'game_id mismatch', { gameA, gameB, user1: opA, user2: opB });
  }
  const gameId = gameA;
  pass('match-created', { game_id: gameId });

  for (let turnNo = 1; turnNo <= Math.max(1, CFG.maxTurns); turnNo++) {
    const stateA = await getMatchState(a.socket, a.userId, a.lId, gameId);
    if (String(stateA?.status || '').toLowerCase() !== 'success') {
      fail('full-game', 'get:match_state failed for user1', stateA);
    }

    const m = stateA.match_state || {};
    const gameStatus = String(m.status || '').toLowerCase();
    if (gameStatus === 'completed') {
      pass('full-game-completed', { turns: turnNo - 1, winner: m.winner || '' });
      a.socket.close();
      b.socket.close();
      process.exit(0);
    }

    const turnUserId = String(m.turn || '');
    const actor = sameId(turnUserId, a.userId) ? a : (sameId(turnUserId, b.userId) ? b : null);
    if (!actor) {
      fail('full-game', 'could not resolve actor from turn', { turn: turnUserId, user1: a.userId, user2: b.userId });
    }

    log('TURN', { turn_no: turnNo, actor_user_id: actor.userId, game_id: gameId });

    if (!CFG.runDice) {
      pass('full-game-skip-dice', { reason: 'SOCKET_TEST_RUN_DICE=false' });
      break;
    }

    const diceRes = await emitAndWait(
      actor.socket,
      'dice:roll',
      'dice:roll:response',
      {
        game_id: gameId,
        contest_id: CFG.contestId,
        l_id: actor.lId,
        user_id: actor.userId,
        session_token: process.env.SOCKET_TEST_SESSION_TOKEN || '',
        device_id: process.env.SOCKET_TEST_DEVICE_ID || '',
        jwt_token: process.env.SOCKET_TEST_JWT_TOKEN || ''
      },
      `dice:roll(${actor.userId})`
    );

    if (diceRes?.success === false || String(diceRes?.status || '').toLowerCase() === 'error') {
      fail('full-game-dice', 'dice roll returned error', diceRes);
    }

    const afterDiceState = await getMatchState(actor.socket, actor.userId, actor.lId, gameId);
    if (String(afterDiceState?.status || '').toLowerCase() !== 'success') {
      fail('full-game', 'get:match_state after dice failed', afterDiceState);
    }
    const afterDiceStatus = String(afterDiceState?.match_state?.status || '').toLowerCase();
    if (afterDiceStatus === 'completed') {
      pass('full-game-completed', { turns: turnNo, winner: afterDiceState?.match_state?.winner || '' });
      a.socket.close();
      b.socket.close();
      process.exit(0);
    }

    if (!CFG.runPieceMove) {
      continue;
    }

    const turnAfterDice = String(afterDiceState?.match_state?.turn || '');
    if (!sameId(turnAfterDice, actor.userId)) {
      continue;
    }

    const move = chooseMoveFromState(afterDiceState, actor.userId, Number(diceRes?.dice_number));
    if (!move || !move.piece_id) {
      log('piece:move-skip', { reason: 'no_legal_auto_move', actor: actor.userId, dice_number: Number(diceRes?.dice_number) });
      continue;
    }

    const moveRes = await emitAndWait(
      actor.socket,
      'piece:move',
      'piece:move:response',
      {
        game_id: gameId,
        contest_id: CFG.contestId,
        l_id: actor.lId,
        user_id: actor.userId,
        piece_id: move.piece_id,
        piece_type: move.piece_type,
        from_pos_last: move.from_pos_last,
        to_pos_last: move.to_pos_last,
        dice_number: move.dice_number
      },
      `piece:move(${actor.userId})`
    );

    if (moveRes?.success === false || String(moveRes?.status || '').toLowerCase() === 'error') {
      log('piece:move-error-nonfatal', { actor: actor.userId, response: moveRes });
    }

    const afterMoveState = await getMatchState(actor.socket, actor.userId, actor.lId, gameId);
    if (String(afterMoveState?.status || '').toLowerCase() !== 'success') {
      fail('full-game', 'get:match_state after piece move failed', afterMoveState);
    }
    if (String(afterMoveState?.match_state?.status || '').toLowerCase() === 'completed') {
      pass('full-game-completed', { turns: turnNo, winner: afterMoveState?.match_state?.winner || '' });
      a.socket.close();
      b.socket.close();
      process.exit(0);
    }
  }

  fail('full-game', `max turns reached without completion (max=${CFG.maxTurns})`);
}

async function main() {
  if (CFG.fullGame) {
    await runFullGameFlow();
    return;
  }
  await runSingleUserFlow();
}

main().catch((err) => fail('script', err?.message || String(err)));

