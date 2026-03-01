import { randomBytes, createHash } from "node:crypto";
import { pool } from "../db/index.js";
import { createChildLogger } from "../logger.js";

const logger = createChildLogger("api-keys");

const KEY_PREFIX = "nxg_";
const KEY_BYTE_LENGTH = 32;

export type Permission = "read" | "write";

export interface ApiKeyRecord {
  id: string;
  project_id: string;
  key_hash: string;
  key_prefix: string;
  label: string | null;
  permissions: Permission[];
  revoked: boolean;
  expires_at: string | null;
  created_at: string;
}

/** Generate a new raw API key in format nxg_<64 hex chars>. */
export function generateApiKey(): string {
  const hex = randomBytes(KEY_BYTE_LENGTH).toString("hex");
  return `${KEY_PREFIX}${hex}`;
}

/** SHA-256 hash of the raw API key for storage. */
export function hashApiKey(rawKey: string): string {
  return createHash("sha256").update(rawKey).digest("hex");
}

/** Extract the first 8 characters of the key for log identification. */
export function extractKeyPrefix(rawKey: string): string {
  return rawKey.slice(0, 8);
}

export interface CreateApiKeyInput {
  projectId: string;
  label?: string;
  permissions?: Permission[];
  expiresAt?: Date;
}

export interface CreateApiKeyResult {
  id: string;
  rawKey: string;
  keyPrefix: string;
  label: string | null;
  permissions: Permission[];
  expiresAt: string | null;
  createdAt: string;
}

/** Create a new API key for a project. Returns the raw key (shown once). */
export async function createApiKey(
  input: CreateApiKeyInput,
): Promise<CreateApiKeyResult> {
  const rawKey = generateApiKey();
  const keyHash = hashApiKey(rawKey);
  const keyPrefix = extractKeyPrefix(rawKey);
  const permissions = input.permissions ?? ["read", "write"];

  const result = await pool.query<ApiKeyRecord>(
    `INSERT INTO api_keys (project_id, key_hash, key_prefix, label, permissions, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, label, permissions, expires_at, created_at`,
    [
      input.projectId,
      keyHash,
      keyPrefix,
      input.label ?? null,
      JSON.stringify(permissions),
      input.expiresAt?.toISOString() ?? null,
    ],
  );

  const row = result.rows[0];
  logger.info(
    { keyPrefix, projectId: input.projectId },
    "API key created",
  );

  return {
    id: row.id,
    rawKey,
    keyPrefix,
    label: row.label,
    permissions: row.permissions,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
  };
}

/** Look up an API key by its raw value. Returns null if not found, revoked, or expired. */
export async function validateApiKey(
  rawKey: string,
): Promise<ApiKeyRecord | null> {
  const keyHash = hashApiKey(rawKey);

  const result = await pool.query<ApiKeyRecord>(
    `SELECT id, project_id, key_hash, key_prefix, label, permissions, revoked, expires_at, created_at
     FROM api_keys
     WHERE key_hash = $1`,
    [keyHash],
  );

  if (result.rows.length === 0) {
    return null;
  }

  const key = result.rows[0];

  if (key.revoked) {
    logger.debug({ keyPrefix: key.key_prefix }, "Rejected revoked API key");
    return null;
  }

  if (key.expires_at && new Date(key.expires_at) < new Date()) {
    logger.debug({ keyPrefix: key.key_prefix }, "Rejected expired API key");
    return null;
  }

  return key;
}
