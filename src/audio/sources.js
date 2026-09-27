// AudioSource abstraction. The analysis pipeline only needs an identity and
// the audio (encoded bytes or raw PCM), so new origins plug in without
// touching it.
//
//   LocalFileSource – files chosen or dropped by the user: encoded bytes.
//   YouTubeSource   – a video played in the official embedded player; its
//                     audio is obtained by capturing the tab the user shares
//                     (see capture.js). Nothing is downloaded from YouTube and
//                     no protection (CORS, DRM, terms) is bypassed.

import { hashArrayBuffer } from "../util/hash.js";
import { tabCaptureSupported } from "./capture.js";

export class AudioSourceUnavailableError extends Error {}

export class AudioSource {
  /** @returns {string} */ get kind() { throw new Error("not implemented"); }
  /** @returns {boolean} */ get available() { return true; }
  /** @returns {Promise<{name:string,size:number|null,type:string,lastModified:number|null}>} */
  async getMetadata() { throw new Error("not implemented"); }
  /** @returns {Promise<ArrayBuffer>} encoded audio bytes */
  async getArrayBuffer() { throw new Error("not implemented"); }
  /** @returns {object} serialisable description stored with the track */
  describe() { return { kind: this.kind }; }
  /** Stable identity; defaults to a content hash. */
  async getIdentity(buffer) { return hashArrayBuffer(buffer ?? (await this.getArrayBuffer())); }
}

export class LocalFileSource extends AudioSource {
  constructor(file) {
    super();
    this.file = file;
  }
  get kind() { return "local"; }
  async getMetadata() {
    const { name, size, type, lastModified } = this.file;
    return { name, size, type, lastModified };
  }
  getArrayBuffer() { return this.file.arrayBuffer(); }
  describe() { return { kind: "local" }; }
}

export const YOUTUBE_UNAVAILABLE_MESSAGE =
  "Analyse YouTube : nécessite la capture audio d'onglet (Chrome ou Edge sur ordinateur).";

export class YouTubeSource extends AudioSource {
  constructor(url) {
    super();
    this.url = url;
    this.videoId = parseYouTubeId(url);
  }
  get kind() { return "youtube"; }
  get available() { return !!this.videoId && tabCaptureSupported(); }
  get watchUrl() { return `https://www.youtube.com/watch?v=${this.videoId}`; }
  async getMetadata() {
    return { name: `YouTube ${this.videoId ?? this.url}`, size: null, type: "youtube", lastModified: null };
  }
  async getArrayBuffer() {
    // Audio comes as PCM from TabAudioCapture, never as downloaded bytes.
    throw new AudioSourceUnavailableError(YOUTUBE_UNAVAILABLE_MESSAGE);
  }
  // A YouTube video is identified by its id, not by the bytes of one capture.
  async getIdentity() { return { id: `youtube:${this.videoId}`, algorithm: "youtube-id" }; }
  describe() { return { kind: "youtube", url: this.watchUrl, videoId: this.videoId, method: "tab-capture" }; }
}

export function parseYouTubeId(url) {
  try {
    const u = new URL(url.trim());
    const host = u.hostname.replace(/^www\.|^m\./, "");
    if (host === "youtu.be") return u.pathname.slice(1).split("/")[0] || null;
    if (host === "youtube.com" || host === "music.youtube.com") {
      if (u.searchParams.get("v")) return u.searchParams.get("v");
      const m = u.pathname.match(/^\/(?:shorts|embed|live)\/([\w-]{6,})/);
      if (m) return m[1];
    }
  } catch { /* not a URL */ }
  return null;
}
