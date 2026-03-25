#!/bin/bash

# Database Schema Backup Script
# Connects to Cassandra via cqlsh and extracts complete schema
# Saves to src/database/schema_backup.cql

# Load environment variables
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
ENV_FILE="$PROJECT_ROOT/.env"

# Source .env file if it exists
if [ -f "$ENV_FILE" ]; then
    export $(cat "$ENV_FILE" | grep -v '^#' | xargs)
fi

# Get Cassandra credentials from environment or use defaults
CASSANDRA_HOST="${CASSANDRA_HOST:-127.0.0.1}"
CASSANDRA_PORT="${CASSANDRA_PORT:-9042}"
CASSANDRA_KEYSPACE="${CASSANDRA_KEYSPACE:-myapp}"
CASSANDRA_USERNAME="${CASSANDRA_USERNAME:-cassandra}"
CASSANDRA_PASSWORD="${CASSANDRA_PASSWORD:-cassandra}"

# Output file
OUTPUT_FILE="$SCRIPT_DIR/schema_backup.cql"

echo "=========================================="
echo "Database Schema Backup"
echo "=========================================="
echo "Host: $CASSANDRA_HOST:$CASSANDRA_PORT"
echo "Keyspace: $CASSANDRA_KEYSPACE"
echo "Output: $OUTPUT_FILE"
echo "=========================================="
echo ""

# Check if cqlsh is available
if ! command -v cqlsh &> /dev/null; then
    echo "Error: cqlsh is not installed or not in PATH"
    echo "Please install Cassandra tools or add cqlsh to your PATH"
    exit 1
fi

# Create backup file with header
cat > "$OUTPUT_FILE" << EOF
-- ============================================
-- Database Schema Backup
-- Generated: $(date -u +"%Y-%m-%d %H:%M:%S UTC")
-- Keyspace: $CASSANDRA_KEYSPACE
-- Host: $CASSANDRA_HOST:$CASSANDRA_PORT
-- ============================================

EOF

# Extract keyspace schema
echo "Extracting keyspace schema..."
cqlsh "$CASSANDRA_HOST" "$CASSANDRA_PORT" -u "$CASSANDRA_USERNAME" -p "$CASSANDRA_PASSWORD" -e "DESCRIBE KEYSPACE $CASSANDRA_KEYSPACE;" >> "$OUTPUT_FILE" 2>/dev/null

if [ $? -ne 0 ]; then
    echo "Warning: Could not extract keyspace schema. Trying without authentication..."
    cqlsh "$CASSANDRA_HOST" "$CASSANDRA_PORT" -e "DESCRIBE KEYSPACE $CASSANDRA_KEYSPACE;" >> "$OUTPUT_FILE" 2>/dev/null
fi

# Add separator
echo "" >> "$OUTPUT_FILE"
echo "-- ============================================" >> "$OUTPUT_FILE"
echo "-- All Tables" >> "$OUTPUT_FILE"
echo "-- ============================================" >> "$OUTPUT_FILE"
echo "" >> "$OUTPUT_FILE"

# Extract all table schemas
echo "Extracting table schemas..."
cqlsh "$CASSANDRA_HOST" "$CASSANDRA_PORT" -u "$CASSANDRA_USERNAME" -p "$CASSANDRA_PASSWORD" -e "USE $CASSANDRA_KEYSPACE; DESCRIBE TABLES;" 2>/dev/null | grep -v "^$" | grep -v "^---" | while read table; do
    if [ ! -z "$table" ]; then
        echo "-- Table: $table" >> "$OUTPUT_FILE"
        cqlsh "$CASSANDRA_HOST" "$CASSANDRA_PORT" -u "$CASSANDRA_USERNAME" -p "$CASSANDRA_PASSWORD" -e "DESCRIBE TABLE $CASSANDRA_KEYSPACE.$table;" >> "$OUTPUT_FILE" 2>/dev/null
        echo "" >> "$OUTPUT_FILE"
    fi
done

if [ $? -ne 0 ]; then
    echo "Warning: Could not extract tables with authentication. Trying without authentication..."
    cqlsh "$CASSANDRA_HOST" "$CASSANDRA_PORT" -e "USE $CASSANDRA_KEYSPACE; DESCRIBE TABLES;" 2>/dev/null | grep -v "^$" | grep -v "^---" | while read table; do
        if [ ! -z "$table" ]; then
            echo "-- Table: $table" >> "$OUTPUT_FILE"
            cqlsh "$CASSANDRA_HOST" "$CASSANDRA_PORT" -e "DESCRIBE TABLE $CASSANDRA_KEYSPACE.$table;" >> "$OUTPUT_FILE" 2>/dev/null
            echo "" >> "$OUTPUT_FILE"
        fi
    done
fi

echo ""
echo "✅ Schema backup completed!"
echo "📁 Saved to: $OUTPUT_FILE"
echo ""

