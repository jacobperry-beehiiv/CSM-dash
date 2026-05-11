import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * AES-256-GCM symmetric encryption for the customer-book snapshot.
 *
 * The encrypted file is committed to the repo as data/snapshot.enc.json,
 * keyed by SNAPSHOT_ENCRYPTION_KEY (a 32-byte key, base64-encoded). The
 * key lives in two places:
 *   • Vercel env vars → so the runtime can decrypt at request time
 *   • GitHub Actions secrets → so the scheduled sync workflow can encrypt
 *
 * GCM gives us authenticated encryption — tampering with the ciphertext
 * fails the auth-tag check, so we know the snapshot wasn't modified by
 * anything other than a holder of the key.
 */

export interface EncryptedEnvelope {
  /** Algorithm string — kept in the file so future-us can rotate if needed. */
  alg: "aes-256-gcm";
  /** Base64-encoded IV (96 bits, the GCM-recommended length). */
  iv: string;
  /** Base64-encoded ciphertext. */
  ct: string;
  /** Base64-encoded auth tag (128 bits). */
  tag: string;
}

function getKey(): Buffer {
  const raw = process.env.SNAPSHOT_ENCRYPTION_KEY;
  if (!raw) {
    throw new Error(
      "SNAPSHOT_ENCRYPTION_KEY is not set. Generate one with " +
        "`openssl rand -base64 32` and add it to your env."
    );
  }
  const key = Buffer.from(raw, "base64");
  if (key.length !== 32) {
    throw new Error(
      `SNAPSHOT_ENCRYPTION_KEY must decode to 32 bytes (got ${key.length}). ` +
        "Generate a fresh one with `openssl rand -base64 32`."
    );
  }
  return key;
}

export function encryptSnapshot(plaintext: string): EncryptedEnvelope {
  const key = getKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    alg: "aes-256-gcm",
    iv: iv.toString("base64"),
    ct: ct.toString("base64"),
    tag: tag.toString("base64"),
  };
}

export function decryptSnapshot(env: EncryptedEnvelope): string {
  if (env.alg !== "aes-256-gcm") {
    throw new Error(`Unsupported snapshot algorithm: ${env.alg}`);
  }
  const key = getKey();
  const iv = Buffer.from(env.iv, "base64");
  const ct = Buffer.from(env.ct, "base64");
  const tag = Buffer.from(env.tag, "base64");
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
  return pt.toString("utf8");
}
