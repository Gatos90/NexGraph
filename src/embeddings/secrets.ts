import crypto from "node:crypto";
import { config } from "../config.js";

const SECRET_VERSION = "v1";
const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;

function getEncryptionKey(): Buffer {
  if (!config.PROJECT_SECRETS_ENCRYPTION_KEY) {
    throw new Error(
      "PROJECT_SECRETS_ENCRYPTION_KEY is required to use project embedding secrets",
    );
  }

  return crypto
    .createHash("sha256")
    .update(config.PROJECT_SECRETS_ENCRYPTION_KEY, "utf8")
    .digest();
}

export function encryptSecret(plaintext: string): string {
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

  const encrypted = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  return `${SECRET_VERSION}:${iv.toString("base64url")}:${authTag.toString("base64url")}:${encrypted.toString("base64url")}`;
}

export function decryptSecret(ciphertext: string): string {
  const key = getEncryptionKey();
  const parts = ciphertext.split(":");
  if (parts.length !== 4 || parts[0] !== SECRET_VERSION) {
    throw new Error("Invalid encrypted secret format");
  }

  const iv = Buffer.from(parts[1], "base64url");
  const authTag = Buffer.from(parts[2], "base64url");
  const payload = Buffer.from(parts[3], "base64url");

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  const decrypted = Buffer.concat([decipher.update(payload), decipher.final()]);
  return decrypted.toString("utf8");
}

