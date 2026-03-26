require('dotenv').config();

const { io } = require('socket.io-client');

const SOCKET_URL = process.env.SOCKET_TEST_URL || 'http://127.0.0.1:3016';
const USER_ID = String(process.env.SOCKET_TEST_USER_ID || '1234');
const CONTEST_ID = String(process.env.SOCKET_TEST_CONTEST_ID || '9');
const L_ID = String(process.env.SOCKET_TEST_L_ID || `lj_${USER_ID}_${CONTEST_ID}`);
const TIMEOUT_MS = Number(process.env.SOCKET_TEST_TIMEOUT_MS || 10000);

const socket = io(SOCKET_URL, {
  transports: ['websocket'],
  timeout: TIMEOUT_MS,
  auth: {
    user_id: USER_ID,
    contest_id: CONTEST_ID,
    l_id: L_ID
  }
});

const timer = setTimeout(() => {
  console.error('socket_test_error=timeout');
  process.exit(1);
}, TIMEOUT_MS + 1000);

socket.on('connect', () => {
  console.log(`socket_connect_ok id=${socket.id} user_id=${USER_ID} contest_id=${CONTEST_ID}`);
});

socket.on('connection:established', (data) => {
  console.log('connection_established=', JSON.stringify(data));
});

socket.on('connect_error', (err) => {
  console.error('socket_connect_error=', err?.message || err);
  clearTimeout(timer);
  process.exit(1);
});

setTimeout(() => {
  socket.close();
  clearTimeout(timer);
  console.log('socket_test_done=true');
  process.exit(0);
}, Math.min(TIMEOUT_MS, 5000));
