import { sha256 } from "@noble/hashes/sha2.js";

export type EncryptedMedia = {
  url: string;
  v: "v2";
  key: { alg: "A256CTR"; ext: true; k: string; key_ops: ["encrypt", "decrypt"]; kty: "oct" };
  iv: string;
  hashes: { sha256: string };
};

export function sameOriginMediaUrl(url: string, homeserver: string): string {
  if (new URL(url).origin !== new URL(homeserver).origin) throw new Error("Media URL is outside this homeserver.");
  return url;
}

const chunkBytes = 1024 * 1024; // AES blocks divide this size evenly.

function base64(bytes: Uint8Array): string {
  return btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join("")).replace(/=+$/, "");
}

function fromBase64(value: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(value + "=".repeat((4 - value.length % 4) % 4)), (char) => char.charCodeAt(0));
}

function counterAt(initial: Uint8Array<ArrayBuffer>, byteOffset: number): Uint8Array<ArrayBuffer> {
  const counter = initial.slice();
  new DataView(counter.buffer).setUint32(12, byteOffset / 16);
  return counter;
}

export async function encryptMedia(file: File): Promise<{ ciphertext: Blob; details: Omit<EncryptedMedia, "url"> }> {
  const key = await crypto.subtle.generateKey({ name: "AES-CTR", length: 256 }, true, ["encrypt", "decrypt"]);
  const exported = await crypto.subtle.exportKey("jwk", key);
  if (!exported.k) throw new Error("Could not export the attachment key.");
  const initial = new Uint8Array(16);
  crypto.getRandomValues(initial.subarray(0, 8));
  const hash = sha256.create();
  const parts: BlobPart[] = [];
  for (let offset = 0; offset < file.size; offset += chunkBytes) {
    const plaintext = await file.slice(offset, offset + chunkBytes).arrayBuffer();
    const encrypted = new Uint8Array(await crypto.subtle.encrypt(
      { name: "AES-CTR", counter: counterAt(initial, offset), length: 64 }, key, plaintext,
    ));
    hash.update(encrypted);
    parts.push(encrypted);
  }
  return {
    ciphertext: new Blob(parts, { type: "application/octet-stream" }),
    details: {
      v: "v2",
      key: { alg: "A256CTR", ext: true, k: exported.k, key_ops: ["encrypt", "decrypt"], kty: "oct" },
      iv: base64(initial),
      hashes: { sha256: base64(hash.digest()) },
    },
  };
}

export async function decryptMedia(stream: ReadableStream<Uint8Array>, details: EncryptedMedia, limit: number): Promise<Blob> {
  if (details.v !== "v2" || details.key?.alg !== "A256CTR" || details.key.kty !== "oct") {
    throw new Error("Unsupported encrypted attachment.");
  }
  const initial = fromBase64(details.iv);
  if (initial.length !== 16) throw new Error("Invalid attachment counter.");
  const key = await crypto.subtle.importKey("jwk", details.key, { name: "AES-CTR" }, false, ["decrypt"]);
  const hash = sha256.create();
  const parts: BlobPart[] = [];
  const reader = stream.getReader();
  let pending = new Uint8Array(0);
  let offset = 0;
  let total = 0;
  const decryptChunk = async (bytes: Uint8Array): Promise<void> => {
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-CTR", counter: counterAt(initial, offset), length: 64 }, key, bytes.slice().buffer,
    );
    parts.push(new Uint8Array(plaintext));
    offset += bytes.length;
  };
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) throw new Error(`Attachment exceeds the ${Math.floor(limit / 1024 / 1024)} MB limit.`);
      hash.update(value);
      const next = new Uint8Array(pending.length + value.length);
      next.set(pending);
      next.set(value, pending.length);
      let consumed = 0;
      while (next.length - consumed >= chunkBytes) {
        await decryptChunk(next.subarray(consumed, consumed + chunkBytes));
        consumed += chunkBytes;
      }
      pending = next.slice(consumed);
    }
    if (pending.length) await decryptChunk(pending);
    if (base64(hash.digest()) !== details.hashes?.sha256) throw new Error("Attachment integrity check failed.");
    return new Blob(parts);
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
}
