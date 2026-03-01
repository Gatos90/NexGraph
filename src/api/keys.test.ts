import { describe, it, expect, vi, beforeEach } from "vitest";
import { createHash } from "node:crypto";
import { generateApiKey, hashApiKey, extractKeyPrefix } from "./keys.js";

// Mock the db module to prevent real pool creation
vi.mock("../db/index.js", () => ({
  pool: { query: vi.fn() },
}));

// Mock logger
vi.mock("../logger.js", () => ({
  createChildLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

describe("generateApiKey", () => {
  it("should return a string starting with nxg_ prefix", () => {
    const key = generateApiKey();
    expect(key).toMatch(/^nxg_/);
  });

  it("should return a 68-character string (4 prefix + 64 hex)", () => {
    const key = generateApiKey();
    expect(key).toHaveLength(68);
  });

  it("should produce unique keys on successive calls", () => {
    const key1 = generateApiKey();
    const key2 = generateApiKey();
    expect(key1).not.toBe(key2);
  });

  it("should contain only hex characters after prefix", () => {
    const key = generateApiKey();
    const hex = key.slice(4);
    expect(hex).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("hashApiKey", () => {
  it("should return a SHA-256 hex digest", () => {
    const key = "nxg_" + "a".repeat(64);
    const hash = hashApiKey(key);
    expect(hash).toHaveLength(64);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("should produce deterministic output for the same input", () => {
    const key = generateApiKey();
    expect(hashApiKey(key)).toBe(hashApiKey(key));
  });

  it("should match Node crypto SHA-256", () => {
    const key = "test-key-value";
    const expected = createHash("sha256").update(key).digest("hex");
    expect(hashApiKey(key)).toBe(expected);
  });

  it("should produce different hashes for different keys", () => {
    const hash1 = hashApiKey("key1");
    const hash2 = hashApiKey("key2");
    expect(hash1).not.toBe(hash2);
  });
});

describe("extractKeyPrefix", () => {
  it("should return the first 8 characters", () => {
    const key = "nxg_abcdefgh1234567890";
    expect(extractKeyPrefix(key)).toBe("nxg_abcd");
  });

  it("should work with a full generated key", () => {
    const key = generateApiKey();
    const prefix = extractKeyPrefix(key);
    expect(prefix).toHaveLength(8);
    expect(key.startsWith(prefix)).toBe(true);
  });
});

describe("createApiKey", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("should insert key with hash and return raw key", async () => {
    const { pool } = await import("../db/index.js");
    const mockQuery = pool.query as ReturnType<typeof vi.fn>;
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          id: "uuid-1",
          label: "test-label",
          permissions: ["read", "write"],
          expires_at: null,
          created_at: "2026-01-01T00:00:00Z",
        },
      ],
    });

    const { createApiKey } = await import("./keys.js");
    const result = await createApiKey({
      projectId: "proj-1",
      label: "test-label",
    });

    expect(result.rawKey).toMatch(/^nxg_/);
    expect(result.rawKey).toHaveLength(68);
    expect(result.id).toBe("uuid-1");
    expect(result.label).toBe("test-label");
    expect(result.permissions).toEqual(["read", "write"]);

    // Verify the query was called with hashed key, not raw
    expect(mockQuery).toHaveBeenCalledOnce();
    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toContain("INSERT INTO api_keys");
    expect(params[0]).toBe("proj-1"); // project_id
    expect(params[1]).toHaveLength(64); // key_hash (sha256 hex)
    expect(params[1]).not.toBe(result.rawKey); // hash, not raw key
    expect(params[2]).toHaveLength(8); // key_prefix
  });

  it("should default permissions to read+write", async () => {
    const { pool } = await import("../db/index.js");
    const mockQuery = pool.query as ReturnType<typeof vi.fn>;
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          id: "uuid-2",
          label: null,
          permissions: ["read", "write"],
          expires_at: null,
          created_at: "2026-01-01T00:00:00Z",
        },
      ],
    });

    const { createApiKey } = await import("./keys.js");
    await createApiKey({ projectId: "proj-1" });

    const params = mockQuery.mock.calls[0][1];
    expect(JSON.parse(params[4])).toEqual(["read", "write"]);
  });
});

describe("validateApiKey", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("should return the key record for a valid key", async () => {
    const { pool } = await import("../db/index.js");
    const mockQuery = pool.query as ReturnType<typeof vi.fn>;
    const record = {
      id: "key-1",
      project_id: "proj-1",
      key_hash: "abc",
      key_prefix: "nxg_abcd",
      label: null,
      permissions: ["read", "write"],
      revoked: false,
      expires_at: null,
      created_at: "2026-01-01T00:00:00Z",
    };
    mockQuery.mockResolvedValueOnce({ rows: [record] });

    const { validateApiKey } = await import("./keys.js");
    const result = await validateApiKey("nxg_" + "a".repeat(64));
    expect(result).toEqual(record);
  });

  it("should return null when key not found", async () => {
    const { pool } = await import("../db/index.js");
    (pool.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      rows: [],
    });

    const { validateApiKey } = await import("./keys.js");
    const result = await validateApiKey("nxg_unknown");
    expect(result).toBeNull();
  });

  it("should return null for a revoked key", async () => {
    const { pool } = await import("../db/index.js");
    (pool.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      rows: [
        {
          id: "key-1",
          project_id: "proj-1",
          key_hash: "abc",
          key_prefix: "nxg_abcd",
          label: null,
          permissions: ["read"],
          revoked: true,
          expires_at: null,
          created_at: "2026-01-01T00:00:00Z",
        },
      ],
    });

    const { validateApiKey } = await import("./keys.js");
    const result = await validateApiKey("nxg_revoked");
    expect(result).toBeNull();
  });

  it("should return null for an expired key", async () => {
    const { pool } = await import("../db/index.js");
    (pool.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      rows: [
        {
          id: "key-1",
          project_id: "proj-1",
          key_hash: "abc",
          key_prefix: "nxg_abcd",
          label: null,
          permissions: ["read"],
          revoked: false,
          expires_at: "2020-01-01T00:00:00Z", // expired
          created_at: "2019-01-01T00:00:00Z",
        },
      ],
    });

    const { validateApiKey } = await import("./keys.js");
    const result = await validateApiKey("nxg_expired");
    expect(result).toBeNull();
  });

  it("should return key record if expires_at is in the future", async () => {
    const { pool } = await import("../db/index.js");
    const futureDate = new Date(Date.now() + 86400_000).toISOString();
    const record = {
      id: "key-1",
      project_id: "proj-1",
      key_hash: "abc",
      key_prefix: "nxg_abcd",
      label: null,
      permissions: ["read"],
      revoked: false,
      expires_at: futureDate,
      created_at: "2026-01-01T00:00:00Z",
    };
    (pool.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      rows: [record],
    });

    const { validateApiKey } = await import("./keys.js");
    const result = await validateApiKey("nxg_future");
    expect(result).toEqual(record);
  });
});
