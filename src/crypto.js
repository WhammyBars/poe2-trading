// Password-based encryption for the published dashboard, using Node's WebCrypto
// (the same SubtleCrypto API the browser uses, so encrypt-here/decrypt-there stay
// in lockstep). PBKDF2-SHA256 derives a key from the password; AES-256-GCM
// encrypts the payload. Salt and IV are not secret and travel with the
// ciphertext — only the password is secret, and it never gets stored anywhere,
// only used transiently to derive a key.
import { webcrypto } from "node:crypto";

const { subtle } = webcrypto;

export const PBKDF2_ITERATIONS = 250_000;

async function deriveKey(password, salt) {
  const passKey = await subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveKey"]);
  return subtle.deriveKey(
    { name: "PBKDF2", salt, iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
    passKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

function toBase64(bytes) {
  return Buffer.from(bytes).toString("base64");
}

function fromBase64(b64) {
  return new Uint8Array(Buffer.from(b64, "base64"));
}

// Returns { salt, iv, ciphertext } all base64-encoded, safe to embed in HTML/JSON.
export async function encryptString(plaintext, password) {
  const salt = webcrypto.getRandomValues(new Uint8Array(16));
  const iv = webcrypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(password, salt);
  const ciphertext = await subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(plaintext));
  return { salt: toBase64(salt), iv: toBase64(iv), ciphertext: toBase64(ciphertext) };
}

export async function decryptString({ salt, iv, ciphertext }, password) {
  const key = await deriveKey(password, fromBase64(salt));
  const plainBuf = await subtle.decrypt({ name: "AES-GCM", iv: fromBase64(iv) }, key, fromBase64(ciphertext));
  return new TextDecoder().decode(plainBuf);
}
