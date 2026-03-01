#!/bin/bash
set -e

# Create AGE, pg_trgm, and pgvector extensions in the nexgraph database.
# This script runs automatically on first container start via
# PostgreSQL's docker-entrypoint-initdb.d mechanism.

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-EOSQL
    CREATE EXTENSION IF NOT EXISTS age;
    CREATE EXTENSION IF NOT EXISTS pg_trgm;
    CREATE EXTENSION IF NOT EXISTS vector;
    LOAD 'age';
    SET search_path = ag_catalog, "\$user", public;
EOSQL
