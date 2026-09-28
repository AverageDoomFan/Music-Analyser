// Minimal audio tag reader: title, artist, album, ISRC.
//   MP3  – ID3v2.3 / 2.4 (TIT2, TPE1, TALB, TSRC)
//   FLAC – Vorbis comments (TITLE, ARTIST, ALBUM, ISRC)
// Falls back to the file name ("Artist - Title.mp3").
// Used to match local files with streaming-service tracks.

export function readTags(buffer, fileName = "") {
  let tags = {};
  try {
    const bytes = new Uint8Array(buffer, 0, Math.min(buffer.byteLength, 1 << 20));
    if (bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) tags = readId3(bytes);
    else if (bytes[0] === 0x66 && bytes[1] === 0x4c && bytes[2] === 0x61 && bytes[3] === 0x43) tags = readFlac(bytes);
  } catch {
    tags = {};
  }
  const fromName = parseFileName(fileName);
  return {
    title: clean(tags.title) || fromName.title,
    artist: clean(tags.artist) || fromName.artist,
    album: clean(tags.album) || null,
    isrc: tags.isrc ? tags.isrc.replace(/[^A-Za-z0-9]/g, "").toUpperCase() : null,
    source: tags.title ? "tags" : "filename",
  };
}

function readId3(b) {
  const version = b[3];
  const flags = b[5];
  const size = syncsafe(b, 6);
  let pos = 10;
  if (flags & 0x40) pos += version === 4 ? syncsafe(b, pos) : be32(b, pos) + 4; // extended header
  const end = Math.min(b.length, 10 + size);
  const out = {};
  const wanted = { TIT2: "title", TPE1: "artist", TALB: "album", TSRC: "isrc" };
  while (pos + 10 <= end) {
    const id = String.fromCharCode(b[pos], b[pos + 1], b[pos + 2], b[pos + 3]);
    if (!/^[A-Z0-9]{4}$/.test(id)) break; // padding
    const len = version === 4 ? syncsafe(b, pos + 4) : be32(b, pos + 4);
    const body = b.subarray(pos + 10, pos + 10 + len);
    if (wanted[id] && body.length > 1) out[wanted[id]] = decodeText(body);
    pos += 10 + len;
  }
  return out;
}

function decodeText(body) {
  const enc = body[0];
  const data = body.subarray(1);
  let text;
  if (enc === 0) text = String.fromCharCode(...data);
  else if (enc === 3) text = new TextDecoder("utf-8").decode(data);
  else if (enc === 1) {
    const le = data[0] === 0xff && data[1] === 0xfe;
    text = new TextDecoder(le ? "utf-16le" : "utf-16be").decode(data.subarray(2));
  } else text = new TextDecoder("utf-16be").decode(data);
  // multiple values are separated by NUL: keep the first
  return text.split("\u0000").filter(Boolean)[0] ?? "";
}

function readFlac(b) {
  let pos = 4;
  const out = {};
  for (;;) {
    if (pos + 4 > b.length) break;
    const last = b[pos] & 0x80;
    const type = b[pos] & 0x7f;
    const len = (b[pos + 1] << 16) | (b[pos + 2] << 8) | b[pos + 3];
    pos += 4;
    if (type === 4) {
      const view = new DataView(b.buffer, b.byteOffset + pos, Math.min(len, b.length - pos));
      let p = 0;
      const vlen = view.getUint32(p, true);
      p += 4 + vlen;
      const n = view.getUint32(p, true);
      p += 4;
      const utf8 = new TextDecoder("utf-8");
      for (let i = 0; i < n && p + 4 <= view.byteLength; i++) {
        const l = view.getUint32(p, true);
        p += 4;
        const s = utf8.decode(new Uint8Array(view.buffer, view.byteOffset + p, Math.min(l, view.byteLength - p)));
        p += l;
        const eq = s.indexOf("=");
        if (eq < 0) continue;
        const key = s.slice(0, eq).toUpperCase();
        const val = s.slice(eq + 1);
        if (key === "TITLE") out.title ??= val;
        if (key === "ARTIST") out.artist ??= val;
        if (key === "ALBUM") out.album ??= val;
        if (key === "ISRC") out.isrc ??= val;
      }
      break;
    }
    pos += len;
    if (last) break;
  }
  return out;
}

/** "01 - Artist - Title (Remaster).mp3" → { artist, title } */
export function parseFileName(name) {
  const base = name.replace(/\.[a-z0-9]{2,5}$/i, "").replace(/_/g, " ").trim();
  const noTrack = base.replace(/^\d{1,3}[\s.\-)]+/, "");
  const parts = noTrack.split(/\s+[-–—]\s+/);
  if (parts.length >= 2) return { artist: parts[0].trim(), title: parts.slice(1).join(" - ").trim() };
  return { artist: null, title: noTrack };
}

const syncsafe = (b, i) => ((b[i] & 0x7f) << 21) | ((b[i + 1] & 0x7f) << 14) | ((b[i + 2] & 0x7f) << 7) | (b[i + 3] & 0x7f);
const be32 = (b, i) => ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;
const clean = (s) => (typeof s === "string" ? s.replace(/\u0000/g, "").trim() : "");
