require('dotenv').config();

const Fastify = require('fastify');
const fastifyCors = require('@fastify/cors');
const fastifyHelmet = require('@fastify/helmet');
const { Server } = require('socket.io');
const registerSocketHandlers = require('./routes/socketRoutes');
const { config } = require('./utils/config');
const socketAuthMiddleware = require('./middleware/socketAuth');

const PORT = config.port;
const HOST = config.host;
const SOCKET_CORS_ORIGIN = config.socketCorsOrigin;

process.noDeprecation = true;

if (typeof process.setMaxListeners === 'function') {
  process.setMaxListeners(0);
}

if (global.gc) {
  setInterval(() => {
    try {
      global.gc();
    } catch (e) {
    }
  }, 30000);
}

const fastify = Fastify({
  logger: false,
  ignoreTrailingSlash: true,
  connectionTimeout: 120000,
  keepAliveTimeout: 72000,
  maxRequestsPerSocket: 0,
  bodyLimit: 2097152,
  disableRequestLogging: true,
  requestIdLogLabel: false,
  requestIdHeader: false,
  maxParamLength: 200,
  caseSensitive: false
});

fastify.get('/health', async (request, reply) => {
  try {
    return {
      status: 'ok',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      services: {
        socket: io?.sockets?.sockets?.size || 0,
        mysql_primary: 'connected',
        redis: 'connected'
      }
    };
  } catch (error) {
    return {
      status: 'error',
      timestamp: new Date().toISOString(),
      error: error.message
    };
  }
});

fastify.register(fastifyHelmet, {
  contentSecurityPolicy: false
});
fastify.register(fastifyCors, {
  origin: SOCKET_CORS_ORIGIN === '*' ? true : SOCKET_CORS_ORIGIN,
  credentials: true
});

const io = new Server(fastify.server, {
  cors: {
    origin: SOCKET_CORS_ORIGIN,
    methods: ["GET", "POST"],
    credentials: true,
  },
  pingInterval: 25000,
  pingTimeout: 20000,
  transports: ['websocket'],
  allowEIO3: false,
  maxHttpBufferSize: 2e6,
  perMessageDeflate: {
    threshold: 2048,
    zlibDeflateOptions: {
      chunkSize: 32 * 1024,
      memLevel: 8,
      level: 1
    }
  },
  connectTimeout: 60000,
  upgradeTimeout: 10000,
  httpCompression: true,
  serveClient: false,
});

io.use(socketAuthMiddleware);

registerSocketHandlers(io);

const start = async () => {
  try {
    const mysqlPrimaryClient = require('./services/mysql/client');
    await mysqlPrimaryClient;
    
    const { getRedis } = require('./utils/redis');
    await getRedis();

    await fastify.ready();
    await new Promise((resolve, reject) => {
      fastify.listen({ port: PORT, host: HOST }, (err) => {
        if (err) {
          reject(err);
          return;
        }
        resolve();
      });
    });
  } catch (err) {
    console.error('[Startup Error]', err?.message || err);
    if (err?.stack) {
      console.error(err.stack);
    }
    process.exit(1);
  }
};

start(); 
