import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

// Mock credentials are fake by intent, but people paste real keys from provider docs,
// so they are encrypted at rest (AES-256-GCM). The key comes from MOCKGW_SECRET_KEY (base64, 32 bytes)
// or is generated once into <data dir>/secret.key.

const g = globalThis as unknown as { __mockKey?: Buffer };

function loadKey(): Buffer {
  if (g.__mockKey) return g.__mockKey;
  let key: Buffer;
  const fromEnv = process.env.MOCKGW_SECRET_KEY;
  if (fromEnv) {
    key = Buffer.from(fromEnv, "base64");
    if (key.length !== 32) throw new Error("MOCKGW_SECRET_KEY must be 32 bytes, base64 encoded");
  } else {
    const dir = process.env.MOCKGW_DATA_DIR ? path.dirname(process.env.MOCKGW_DATA_DIR) : "./.data";
    const file = path.join(dir, "secret.key");
    if (existsSync(file)) {
      key = Buffer.from(readFileSync(file, "utf8").trim(), "base64");
    } else {
      mkdirSync(dir, { recursive: true });
      key = randomBytes(32);
      writeFileSync(file, key.toString("base64"), { mode: 0o600 });
    }
  }
  g.__mockKey = key;
  return key;
}

export function encryptSecret(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", loadKey(), iv);
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64"), cipher.getAuthTag().toString("base64"), ct.toString("base64")].join(":");
}

export function decryptSecret(stored: string): string {
  const [v, iv, tag, ct] = stored.split(":");
  if (v !== "v1" || !iv || !tag || !ct) throw new Error("unrecognised secret format");
  const decipher = createDecipheriv("aes-256-gcm", loadKey(), Buffer.from(iv, "base64"));
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(ct, "base64")), decipher.final()]).toString("utf8");
}
