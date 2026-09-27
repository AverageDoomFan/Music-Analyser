// File identity: SHA-256 of the file content when WebCrypto is available
// (secure contexts: https, localhost), FNV-1a 64 bits otherwise.

export async function hashArrayBuffer(buffer) {
  if (globalThis.crypto?.subtle) {
    const digest = await crypto.subtle.digest("SHA-256", buffer);
    return { id: toHex(new Uint8Array(digest)), algorithm: "sha-256" };
  }
  return { id: fnv1a64(new Uint8Array(buffer)), algorithm: "fnv1a-64" };
}

function toHex(bytes) {
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
}

function fnv1a64(bytes) {
  let h1 = 0x811c9dc5, h2 = 0xcbf29ce4;
  for (let i = 0; i < bytes.length; i++) {
    h1 = Math.imul(h1 ^ bytes[i], 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ bytes[(bytes.length - 1 - i)], 0x01000193) >>> 0;
  }
  return h1.toString(16).padStart(8, "0") + h2.toString(16).padStart(8, "0") + "-" + bytes.length.toString(16);
}
