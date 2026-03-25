const fs = require('fs');
const path = require('path');
const cassandra = require('cassandra-driver');
const { config } = require('../utils/config');

const OUTPUT_FILE = path.join(__dirname, 'schema_backup.cql');
const CASSANDRA_HOST = config.cassandra.host;
const CASSANDRA_PORT = config.cassandra.port;
const CASSANDRA_KEYSPACE = config.cassandra.keyspace;
const CASSANDRA_USERNAME = config.cassandra.username;
const CASSANDRA_PASSWORD = config.cassandra.password;
const CASSANDRA_DATACENTER = config.cassandra.datacenter;

// ============================================================================
// Normalize Cassandra map columns (which might already be JS objects/Maps)
// ============================================================================
function toPlainObject(value) {
  if (!value) {
    return {};
  }

  if (typeof value === 'string') {
    try {
      return JSON.parse(value);
    } catch (err) {
      return {};
    }
  }

  if (value instanceof Map) {
    return Object.fromEntries(value.entries());
  }

  if (typeof value === 'object') {
    return value;
  }

  return {};
}

// ============================================================================
// Build CREATE TABLE statement from system_schema
// ============================================================================
async function buildTableSchemaFromSystemSchema(client, keyspaceName, tableName) {
  try {
    // Get table metadata
    const tableQuery = `
      SELECT table_name, bloom_filter_fp_chance, caching, comment, 
             compaction, compression, crc_check_chance, dclocal_read_repair_chance,
             default_time_to_live, extensions, gc_grace_seconds, max_index_interval,
             memtable_flush_period_in_ms, min_index_interval, read_repair_chance,
             speculative_retry
      FROM system_schema.tables
      WHERE keyspace_name = ? AND table_name = ?
    `;

    const tableResult = await client.execute(tableQuery, [keyspaceName, tableName], { prepare: true });

    if (tableResult.rows.length === 0) {
      return null;
    }

    const tableRow = tableResult.rows[0];

    // Get columns
    const columnsQuery = `
      SELECT column_name, kind, type, position
      FROM system_schema.columns
      WHERE keyspace_name = ? AND table_name = ?
    `;

    const columnsResult = await client.execute(columnsQuery, [keyspaceName, tableName], { prepare: true });

    // Sort by position in JavaScript
    const sortedRows = columnsResult.rows.sort((a, b) => {
      const posA = a.position || 0;
      const posB = b.position || 0;
      return posA - posB;
    });

    // Separate columns by kind
    const partitionKeys = [];
    const clusteringKeys = [];
    const regularColumns = [];
    const staticColumns = [];

    sortedRows.forEach(row => {
      const columnDef = {
        name: row.column_name,
        type: row.type,
        position: row.position || 0
      };

      if (row.kind === 'partition_key') {
        partitionKeys.push(columnDef);
      } else if (row.kind === 'clustering') {
        clusteringKeys.push(columnDef);
      } else if (row.kind === 'static') {
        staticColumns.push(columnDef);
      } else {
        regularColumns.push(columnDef);
      }
    });

    // Sort each group by position
    partitionKeys.sort((a, b) => a.position - b.position);
    clusteringKeys.sort((a, b) => a.position - b.position);

    // Build CREATE TABLE statement
    let createTable = `CREATE TABLE IF NOT EXISTS ${keyspaceName}.${tableName} (\n`;

    // Add all columns in order: partition keys, clustering keys, regular columns, static columns
    const allColumns = [...partitionKeys, ...clusteringKeys, ...regularColumns, ...staticColumns];
    const columnDefs = allColumns.map(col => `  ${col.name} ${col.type}`);
    createTable += columnDefs.join(',\n');

    // Add primary key
    const primaryKeyParts = [];
    if (partitionKeys.length > 0) {
      if (partitionKeys.length === 1) {
        primaryKeyParts.push(partitionKeys[0].name);
      } else {
        primaryKeyParts.push(`(${partitionKeys.map(k => k.name).join(', ')})`);
      }
    }

    if (clusteringKeys.length > 0) {
      primaryKeyParts.push(...clusteringKeys.map(k => k.name));
    }

    createTable += `,\n  PRIMARY KEY (${primaryKeyParts.join(', ')})\n`;

    // Add table options
    const options = [];

    if (tableRow.compaction) {
      const compaction = toPlainObject(tableRow.compaction);
      if (Object.keys(compaction).length > 0) {
        const compactionStr = Object.entries(compaction)
          .map(([key, value]) => `'${key}': '${value}'`)
          .join(', ');
        options.push(`compaction = {${compactionStr}}`);
      }
    }

    if (tableRow.compression) {
      const compression = toPlainObject(tableRow.compression);
      if (Object.keys(compression).length > 0) {
        const compressionStr = Object.entries(compression)
          .map(([key, value]) => `'${key}': '${value}'`)
          .join(', ');
        options.push(`compression = {${compressionStr}}`);
      }
    }

    if (tableRow.caching) {
      const caching = toPlainObject(tableRow.caching);
      if (Object.keys(caching).length > 0) {
        const cachingStr = Object.entries(caching)
          .map(([key, value]) => `'${key}': '${value}'`)
          .join(', ');
        options.push(`caching = {${cachingStr}}`);
      }
    }

    if (tableRow.comment) {
      options.push(`comment = '${tableRow.comment.replace(/'/g, "''")}'`);
    }

    if (tableRow.default_time_to_live) {
      options.push(`default_time_to_live = ${tableRow.default_time_to_live}`);
    }

    if (tableRow.gc_grace_seconds) {
      options.push(`gc_grace_seconds = ${tableRow.gc_grace_seconds}`);
    }

    if (options.length > 0) {
      createTable += ') WITH\n  ' + options.join('\n  AND ');
    } else {
      createTable += ')';
    }

    createTable += ';';

    return createTable;
  } catch (error) {
    process.stderr.write(`Error building table schema for ${tableName}: ${error.message}\n`);
    return null;
  }
}

// ============================================================================
// Get complete keyspace description using metadata API
// ============================================================================
async function describeKeyspaceViaQuery(client, keyspaceName) {
  try {
    const metadata = client.metadata;

    // Access keyspace from metadata.keyspaces object
    let keyspace = metadata.keyspaces[keyspaceName];

    if (!keyspace) {
      // Try refreshing again
      await metadata.refreshKeyspace(keyspaceName);
      await new Promise(resolve => setTimeout(resolve, 500));
      keyspace = metadata.keyspaces[keyspaceName];
    }

    if (!keyspace) {
      throw new Error(`Keyspace ${keyspaceName} not found in metadata`);
    }

    console.log(`Found keyspace: ${keyspaceName}`);

    // Build complete schema description
    let schema = '';

    // Keyspace definition - get replication from system_schema if metadata doesn't have it
    let replication = keyspace.replication || {};
    if (Object.keys(replication).length === 0) {
      // Query system_schema directly
      const replicationQuery = `
        SELECT replication, durable_writes
        FROM system_schema.keyspaces
        WHERE keyspace_name = ?
      `;
      const result = await client.execute(replicationQuery, [keyspaceName], { prepare: true });
      if (result.rows.length > 0) {
        replication = result.rows[0].replication || {};
      }
    }

    const replicationStr = Object.entries(replication)
      .map(([key, value]) => `'${key}': '${value}'`)
      .join(', ');

    schema += `CREATE KEYSPACE IF NOT EXISTS ${keyspaceName}\n`;
    schema += `WITH replication = {${replicationStr}}\n`;
    schema += `AND durable_writes = ${keyspace.durableWrites !== false ? 'true' : 'false'};\n\n`;
    schema += `USE ${keyspaceName};\n\n`;

    // Get all tables - tables is an object
    const tables = keyspace.tables || {};
    const tableNames = Object.keys(tables).sort();

    console.log(`Found ${tableNames.length} tables in metadata`);

    if (tableNames.length === 0) {
      // Fallback: query system_schema directly
      console.log('No tables in metadata, querying system_schema directly...');
      const tablesQuery = `
        SELECT table_name
        FROM system_schema.tables
        WHERE keyspace_name = ?
        ORDER BY table_name ASC
      `;
      const tablesResult = await client.execute(tablesQuery, [keyspaceName], { prepare: true });
      const directTableNames = tablesResult.rows.map(row => row.table_name);
      console.log(`Found ${directTableNames.length} tables via direct query`);

      // Refresh metadata for each table to try to load them
      for (const tableName of directTableNames) {
        try {
          await metadata.refreshTable(keyspaceName, tableName);
        } catch (err) {
          // Ignore refresh errors
        }
      }

      // Wait a bit for tables to load
      await new Promise(resolve => setTimeout(resolve, 1000));

      // Try again to get tables from metadata
      const refreshedKeyspace = metadata.keyspaces[keyspaceName];
      const refreshedTables = refreshedKeyspace ? (refreshedKeyspace.tables || {}) : {};

      // Build table schemas from system_schema
      for (const tableName of directTableNames) {
        const table = refreshedTables[tableName];
        if (table && typeof table.asCql === 'function') {
          schema += table.asCql() + '\n\n';
        } else {
          // Build table schema from system_schema
          console.log(`  Building schema for: ${tableName}...`);
          const tableSchema = await buildTableSchemaFromSystemSchema(client, keyspaceName, tableName);
          if (tableSchema) {
            schema += tableSchema + '\n\n';
          } else {
            schema += `-- Table: ${tableName}\n`;
            schema += `-- Note: Could not extract full schema\n\n`;
          }
        }
      }
    } else {
      for (const tableName of tableNames) {
        const table = tables[tableName];
        if (table && typeof table.asCql === 'function') {
          schema += table.asCql() + '\n\n';
        }
      }
    }

    // Get all types (UDTs) - types is an object
    const types = keyspace.types || {};
    const typeNames = Object.keys(types).sort();

    for (const typeName of typeNames) {
      const type = types[typeName];
      if (type && typeof type.asCql === 'function') {
        schema += type.asCql() + '\n\n';
      }
    }

    // Get all functions - functions is an object
    const functions = keyspace.functions || {};
    const functionNames = Object.keys(functions).sort();

    for (const functionName of functionNames) {
      const functionDef = functions[functionName];
      if (functionDef && typeof functionDef.asCql === 'function') {
        schema += functionDef.asCql() + '\n\n';
      }
    }

    // Get all aggregates - aggregates is an object
    const aggregates = keyspace.aggregates || {};
    const aggregateNames = Object.keys(aggregates).sort();

    for (const aggregateName of aggregateNames) {
      const aggregate = aggregates[aggregateName];
      if (aggregate && typeof aggregate.asCql === 'function') {
        schema += aggregate.asCql() + '\n\n';
      }
    }

    return schema;
  } catch (error) {
    process.stderr.write(`Error describing keyspace: ${error.message}\n`);
    throw error;
  }
}

// ============================================================================
// Main backup function
// ============================================================================
async function backupSchema() {
  let client = null;

  try {
    console.log('==========================================');
    console.log('Database Schema Backup');
    console.log('==========================================');
    console.log(`Host: ${CASSANDRA_HOST}:${CASSANDRA_PORT}`);
    console.log(`Keyspace: ${CASSANDRA_KEYSPACE}`);
    console.log(`Output: ${OUTPUT_FILE}`);
    console.log('==========================================\n');

    // Connect to Cassandra
    const authProvider = new cassandra.auth.PlainTextAuthProvider(
      CASSANDRA_USERNAME,
      CASSANDRA_PASSWORD
    );

    client = new cassandra.Client({
      contactPoints: [CASSANDRA_HOST],
      localDataCenter: CASSANDRA_DATACENTER,
      authProvider,
    });

    await client.connect();
    console.log('✅ Connected to Cassandra');

    // Wait a moment for metadata to initialize
    await new Promise(resolve => setTimeout(resolve, 1000));

    // Get full keyspace description (equivalent to DESCRIBE KEYSPACE)
    console.log('Extracting complete keyspace schema...');
    console.log('Refreshing metadata...');

    const metadata = client.metadata;
    await metadata.refreshKeyspace(CASSANDRA_KEYSPACE);

    // Wait a bit more for refresh to complete
    await new Promise(resolve => setTimeout(resolve, 500));

    console.log('Metadata refreshed, extracting schema...');
    const schemaDescription = await describeKeyspaceViaQuery(client, CASSANDRA_KEYSPACE);

    // Create backup file with header
    const header = [
      '-- ============================================',
      '-- Database Schema Backup',
      `-- Generated: ${new Date().toISOString()}`,
      `-- Keyspace: ${CASSANDRA_KEYSPACE}`,
      `-- Host: ${CASSANDRA_HOST}:${CASSANDRA_PORT}`,
      '-- Equivalent to: DESCRIBE KEYSPACE ' + CASSANDRA_KEYSPACE,
      '-- ============================================',
      ''
    ];

    const backupContent = header.join('\n') + schemaDescription;

    // Write to file
    fs.writeFileSync(OUTPUT_FILE, backupContent, 'utf8');

    // Count tables from the schema description
    const tableMatches = schemaDescription.match(/CREATE TABLE[^;]+;/gi);
    const tableCount = tableMatches ? tableMatches.length : 0;

    console.log('\n✅ Schema backup completed!');
    console.log(`📁 Saved to: ${OUTPUT_FILE}`);
    console.log(`📊 Total tables: ${tableCount}`);
    console.log(`📋 Includes: Tables, Types, Functions, Aggregates`);

  } catch (error) {
    process.stderr.write(`\n❌ Error during schema backup: ${error.message}\n`);
    process.stderr.write(`${error.stack}\n`);
    process.exit(1);
  } finally {
    if (client) {
      await client.shutdown();
      console.log('\nDisconnected from Cassandra');
    }
  }
}

// Run backup if executed directly
if (require.main === module) {
  backupSchema().catch(error => {
    process.stderr.write(`Fatal error: ${error}\n`);
    process.exit(1);
  });
}

module.exports = { backupSchema };
