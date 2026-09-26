export type EncryptedMedia = {
  url: string;
  v: "v2";
  key: { alg: "A256CTR"; ext: true; k: string; key_ops: ["encrypt", "decrypt"]; kty: "oct" };
  iv: string;
  hashes: { sha256: string };
};

function base64(bytes: Uint8Array): string {
  return btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join("")).replace(/=+$/, "");
}

function fromBase64(value: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(value + "=".repeat((4 - value.length % 4) % 4)), (char) => char.charCodeAt(0));
}

export async function encryptMedia(file: File): Promise<{ ciphertext: ArrayBuffer; details: Omit<EncryptedMedia, "url"> }> {
  const key = await crypto.subtle.generateKey({ name: "AES-CTR", length: 256 }, true, ["encrypt", "decrypt"]);
  const exported = await crypto.subtle.exportKey("jwk", key);
  if (!exported.k) throw new Error("Could not export the attachment key.");
  const counter = new Uint8Array(16);
  crypto.getRandomValues(counter.subarray(0, 8));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-CTR", counter, length: 64 }, key, await file.arrayBuffer());
  const digest = await crypto.subtle.digest("SHA-256", ciphertext);
  return {
    ciphertext,
    details: {
      v: "v2",
      key: { alg: "A256CTR", ext: true, k: exported.k, key_ops: ["encrypt", "decrypt"], kty: "oct" },
      iv: base64(counter),
      hashes: { sha256: base64(new Uint8Array(digest)) },
    },
  };
}

export async function decryptMedia(ciphertext: ArrayBuffer, details: EncryptedMedia): Promise<ArrayBuffer> {
  if (details.v !== "v2" || details.key?.alg !== "A256CTR" || details.key.kty !== "oct") {
    throw new Error("Unsupported encrypted attachment.");
  }
  const digest = await crypto.subtle.digest("SHA-256", ciphertext);
  if (base64(new Uint8Array(digest)) !== details.hashes?.sha256) throw new Error("Attachment integrity check failed.");
  const counter = fromBase64(details.iv);
  if (counter.length !== 16) throw new Error("Invalid attachment counter.");
  const key = await crypto.subtle.importKey("jwk", details.key, { name: "AES-CTR" }, false, ["decrypt"]);
  return crypto.subtle.decrypt({ name: "AES-CTR", counter, length: 64 }, key, ciphertext);
}
