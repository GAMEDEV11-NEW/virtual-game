const { createSimpleRedisClient } = require('./redis');

const SOCKET_RELAY_CHANNEL = 'socket:relay:events';

let relayPublisherPromise = null;
let relaySubscriberPromise = null;
let relaySubscriberInitialized = false;

async function getRelayPublisher() {
  if (!relayPublisherPromise) {
    relayPublisherPromise = Promise.resolve(createSimpleRedisClient());
  }
  return relayPublisherPromise;
}

async function getRelaySubscriber() {
  if (!relaySubscriberPromise) {
    relaySubscriberPromise = Promise.resolve(createSimpleRedisClient());
  }
  return relaySubscriberPromise;
}

async function publishSocketEvent(socketId, event, payload) {
  if (!socketId || !event) {
    return false;
  }

  try {
    const publisher = await getRelayPublisher();
    const message = JSON.stringify({
      socketId: String(socketId),
      event: String(event),
      payload: payload ?? {},
      timestamp: new Date().toISOString()
    });
    await publisher.publish(SOCKET_RELAY_CHANNEL, message);
    return true;
  } catch (_) {
    return false;
  }
}

function buildSocketEmitterAdapter() {
  const createRelaySocket = (socketId) => ({
    connected: true,
    emit: (event, payload) => {
      publishSocketEvent(socketId, event, payload).catch(() => {});
    }
  });

  return {
    sockets: {
      sockets: {
        has: (socketId) => Boolean(socketId),
        get: (socketId) => createRelaySocket(socketId)
      }
    },
    to: (socketId) => ({
      emit: (event, payload) => {
        publishSocketEvent(socketId, event, payload).catch(() => {});
      }
    })
  };
}

async function initializeSocketRelaySubscriber(io) {
  if (!io || relaySubscriberInitialized) {
    return;
  }

  const subscriber = await getRelaySubscriber();
  relaySubscriberInitialized = true;

  await subscriber.subscribe(SOCKET_RELAY_CHANNEL);

  subscriber.on('message', (channel, rawMessage) => {
    if (channel !== SOCKET_RELAY_CHANNEL || !rawMessage) {
      return;
    }

    try {
      const data = JSON.parse(rawMessage);
      const socketId = data?.socketId;
      const event = data?.event;
      const payload = data?.payload ?? {};

      if (!socketId || !event) {
        return;
      }

      if (!io.sockets.sockets.has(socketId)) {
        return;
      }

      const socket = io.sockets.sockets.get(socketId);
      if (!socket || !socket.connected) {
        return;
      }

      socket.emit(event, payload);
    } catch (_) {
    }
  });
}

module.exports = {
  publishSocketEvent,
  buildSocketEmitterAdapter,
  initializeSocketRelaySubscriber
};
