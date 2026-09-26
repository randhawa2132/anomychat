import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { encryptMedia, decryptMedia } from "../src/media.ts";

test("large encrypted media survives streamed download and detects tampering", async () => {
  const original = randomBytes(2 * 1024 * 1024 + 37);
  const file = new File([original], "sample.bin");
  const { ciphertext, details } = await encryptMedia(file);
  const metadata = { ...details, url: "mxc://example.com/sample" };
  assert.equal(ciphertext.size, original.length);
  const decrypted = await decryptMedia(ciphertext.stream(), metadata, original.length);
  assert.deepEqual(Buffer.from(await decrypted.arrayBuffer()), original);

  const changed = new Uint8Array(await ciphertext.arrayBuffer());
  changed[1024 * 1024 + 3] ^= 1;
  await assert.rejects(decryptMedia(new Blob([changed]).stream(), metadata, original.length), /integrity check/);
  await assert.rejects(decryptMedia(ciphertext.stream(), metadata, original.length - 1), /exceeds/);
});
