/**
 * Credential blob encryption (AES-256-GCM).
 * `credentials.data_enc` layout: [12-byte IV][16-byte auth tag][ciphertext].
 * Key: CRED_ENC_KEY env — 64 hex chars (openssl rand -hex 32).
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

function key() {
  const hex = process.env.CRED_ENC_KEY;
  if (!hex || hex.length !== 64) {
    throw new Error('CRED_ENC_KEY must be set to 64 hex chars (openssl rand -hex 32)');
  }
  return Buffer.from(hex, 'hex');
}

export function encryptCredential(obj) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(), iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(obj), 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);
}

export function decryptCredential(buf) {
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const ciphertext = buf.subarray(28);
  const decipher = createDecipheriv('aes-256-gcm', key(), iv);
  decipher.setAuthTag(tag);
  return JSON.parse(Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8'));
}
