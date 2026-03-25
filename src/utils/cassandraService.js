const cassandra = require('cassandra-driver');
const { config } = require('./config');

let cassandraClient;
let cassandraSession;

// ============================================================================
// Initialize Cassandra database connection
// ============================================================================
async function initDB() {
  if (cassandraSession) {
    return cassandraSession;
  }

  // Only use authentication if username and password are provided
  const authProvider = (config.cassandra.username && config.cassandra.password)
    ? new cassandra.auth.PlainTextAuthProvider(
        config.cassandra.username,
        config.cassandra.password
      )
    : undefined;

  // Include port in contactPoints
  const contactPoint = `${config.cassandra.host}:${config.cassandra.port}`;
  
  const clientConfig = {
    contactPoints: [contactPoint],
    localDataCenter: config.cassandra.datacenter,
    keyspace: config.cassandra.keyspace,
    pooling: {
      coreConnectionsPerHost: {
        [cassandra.types.distance.local]: 16,
        [cassandra.types.distance.remote]: 8
      },
      maxConnectionsPerHost: {
        [cassandra.types.distance.local]: 64,
        [cassandra.types.distance.remote]: 16
      },
      heartBeatInterval: 30000,
      maxRequestsPerConnection: 65536
    },
    socketOptions: {
      connectTimeout: 5000,
      readTimeout: 12000,
      keepAlive: true,
      keepAliveDelay: 0
    },
    queryOptions: {
      consistency: cassandra.types.consistencies.localQuorum,
      prepare: true,
      fetchSize: 5000,
      defaultTimestamp: Date.now
    },
    protocolOptions: {
      maxVersion: 4,
      maxSchemaAgreementWait: 10000
    },
    compression: false
  };
  
  // Only add authProvider if authentication is configured
  if (authProvider) {
    clientConfig.authProvider = authProvider;
  }
  
  cassandraClient = new cassandra.Client(clientConfig);

  cassandraSession = cassandraClient;
  
  try {
    await cassandraSession.connect();
    await cassandraSession.execute('SELECT release_version FROM system.local');
    return cassandraSession;
  } catch (error) {
    throw error;
  }
}

// ============================================================================
// Get Cassandra session
// ============================================================================
function getSession() {
  if (!cassandraSession) {
    throw new Error('Cassandra session not initialized');
  }
  return cassandraSession;
}

// ============================================================================
// Get Cassandra client
// ============================================================================
function getClient() {
  if (!cassandraClient) {
    throw new Error('Cassandra client not initialized');
  }
  return cassandraClient;
}

// ============================================================================
// Shutdown Cassandra database connection
// ============================================================================
async function shutdownDB() {
  if (cassandraClient) {
    await cassandraClient.shutdown();
    cassandraClient = undefined;
    cassandraSession = undefined;
  }
}

module.exports = {
  initDB,
  getSession,
  getClient,
  shutdownDB
};
