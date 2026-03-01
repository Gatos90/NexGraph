import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock config
const mockConfig = vi.hoisted(() => ({
  PROJECT_SECRETS_ENCRYPTION_KEY: "test-encryption-key-12345",
}));

vi.mock("../config.js", () => ({
  config: mockConfig,
}));

import { encryptSecret, decryptSecret } from "./secrets.js";

describe("encryptSecret / decryptSecret", () => {
  it("roundtrips a simple string", () => {
    const plaintext = "sk-abc123-my-secret-key";
    const encrypted = encryptSecret(plaintext);
    const decrypted = decryptSecret(encrypted);
    expect(decrypted).toBe(plaintext);
  });

  it("roundtrips an empty string", () => {
    const plaintext = "";
    const encrypted = encryptSecret(plaintext);
    const decrypted = decryptSecret(encrypted);
    expect(decrypted).toBe(plaintext);
  });

  it("roundtrips unicode characters", () => {
    const plaintext = "key-with-émojis-🔑-and-ñ";
    const encrypted = encryptSecret(plaintext);
    const decrypted = decryptSecret(encrypted);
    expect(decrypted).toBe(plaintext);
  });

  it("roundtrips a long string", () => {
    const plaintext = "x".repeat(10_000);
    const encrypted = encryptSecret(plaintext);
    const decrypted = decryptSecret(encrypted);
    expect(decrypted).toBe(plaintext);
  });

  it("produces different ciphertexts each time (random IV)", () => {
    const plaintext = "deterministic-test";
    const a = encryptSecret(plaintext);
    const b = encryptSecret(plaintext);
    expect(a).not.toBe(b);
    // Both should still decrypt to the same plaintext
    expect(decryptSecret(a)).toBe(plaintext);
    expect(decryptSecret(b)).toBe(plaintext);
  });

  it("produces output in v1:iv:authTag:payload format", () => {
    const encrypted = encryptSecret("hello");
    const parts = encrypted.split(":");
    expect(parts).toHaveLength(4);
    expect(parts[0]).toBe("v1");
    // IV, authTag, payload should be non-empty base64url strings
    for (let i = 1; i < 4; i++) {
      expect(parts[i].length).toBeGreaterThan(0);
      expect(parts[i]).toMatch(/^[A-Za-z0-9_-]+$/); // base64url charset
    }
  });
});

describe("decryptSecret validation", () => {
  it("throws on missing version prefix", () => {
    expect(() => decryptSecret("iv:tag:payload")).toThrow(
      "Invalid encrypted secret format",
    );
  });

  it("throws on wrong version prefix", () => {
    expect(() => decryptSecret("v2:iv:tag:payload")).toThrow(
      "Invalid encrypted secret format",
    );
  });

  it("throws on too few parts", () => {
    expect(() => decryptSecret("v1:iv:tag")).toThrow(
      "Invalid encrypted secret format",
    );
  });

  it("throws on too many parts", () => {
    expect(() => decryptSecret("v1:iv:tag:payload:extra")).toThrow(
      "Invalid encrypted secret format",
    );
  });

  it("throws on tampered ciphertext", () => {
    const encrypted = encryptSecret("test");
    const parts = encrypted.split(":");
    // Tamper with the payload
    parts[3] = "AAAA" + parts[3].slice(4);
    expect(() => decryptSecret(parts.join(":"))).toThrow();
  });

  it("throws on tampered auth tag", () => {
    const encrypted = encryptSecret("test");
    const parts = encrypted.split(":");
    // Tamper with the auth tag
    parts[2] = "AAAA" + parts[2].slice(4);
    expect(() => decryptSecret(parts.join(":"))).toThrow();
  });
});

describe("encryptSecret without encryption key", () => {
  beforeEach(() => {
    mockConfig.PROJECT_SECRETS_ENCRYPTION_KEY = "";
  });

  afterEach(() => {
    mockConfig.PROJECT_SECRETS_ENCRYPTION_KEY = "test-encryption-key-12345";
  });

  it("throws when encryption key is missing", () => {
    expect(() => encryptSecret("hello")).toThrow(
      "PROJECT_SECRETS_ENCRYPTION_KEY is required",
    );
  });

  it("throws on decrypt when encryption key is missing", () => {
    expect(() => decryptSecret("v1:aaa:bbb:ccc")).toThrow(
      "PROJECT_SECRETS_ENCRYPTION_KEY is required",
    );
  });
});

// Import afterEach for the block above
import { afterEach } from "vitest";
