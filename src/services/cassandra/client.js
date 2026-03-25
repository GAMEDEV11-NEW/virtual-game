const { initDB, getClient } = require('../../utils/cassandraService');

let cassandraClient = null;
let initPromise = null;

// ============================================================================
// Initialize Cassandra client
// ============================================================================
async function initialize() {
  if (initPromise) return initPromise;
  
  initPromise = (async () => {
    try {
      await initDB();
      cassandraClient = getClient();
      return cassandraClient;
    } catch (err) {
      throw err;
    }
  })();
  
  return initPromise;
}

initialize().catch(() => {});

const clientProxy = new Proxy({}, {
  get(target, prop) {
    if (cassandraClient) {
      const value = cassandraClient[prop];
      if (typeof value === 'function') {
        return value.bind(cassandraClient);
      }
      return value;
    }
    
    if (prop === 'execute' || prop === 'batch' || prop === 'stream') {
      return async (...args) => {
        const client = await initPromise;
        return client[prop](...args);
      };
    }
    
    if (prop === 'then' || prop === 'catch' || prop === 'finally') {
      return initPromise[prop].bind(initPromise);
    }
    
    return initPromise.then(client => {
      const value = client[prop];
      return typeof value === 'function' ? value.bind(client) : value;
    });
  }
});

module.exports = clientProxy;
