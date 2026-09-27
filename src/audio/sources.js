// AudioSource abstraction. The analysis pipeline only needs an identity and
// the encoded audio bytes, so new origins can be added without touching it.
//
//   LocalFileSource – files chosen or dropped by the user (implemented)
//   YouTubeSource   – placeholder: a static page must not bypass YouTube's
//                     restrictions (CORS, terms of service). It would need a
//                     compatible external service/tool providing the audio
//                     legitimately; until then it reports itself unavailable.

import { hashArrayBuffer } from "../util/hash.js";

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

export const YOUTUBE_UNAVAILABLE_MESSAGE = "Analyse YouTube : nécessite un service/outil compatible.";

export class YouTubeSource extends AudioSource {
  constructor(url, provider = null) {
    super();
    this.url = url;
    this.videoId = parseYouTubeId(url);
    // provider: optional object { fetchAudio(videoId): Promise<ArrayBuffer>, name }
    // backed by a service the user is entitled to use. None ships with the app.
    this.provider = provider;
  }
  get kind() { return "youtube"; }
  get available() { return !!(this.videoId && this.provider); }
  async getMetadata() {
    return { name: `YouTube ${this.videoId ?? this.url}`, size: null, type: "youtube", lastModified: null };
  }
  async getArrayBuffer() {
    if (!this.videoId) throw new AudioSourceUnavailableError("Lien YouTube invalide.");
    if (!this.provider) throw new AudioSourceUnavailableError(YOUTUBE_UNAVAILABLE_MESSAGE);
    return this.provider.fetchAudio(this.videoId);
  }
  // A YouTube video is identified by its id, not by the bytes of one download.
  async getIdentity() { return { id: `youtube:${this.videoId}`, algorithm: "youtube-id" }; }
  describe() { return { kind: "youtube", url: this.url, videoId: this.videoId, provider: this.provider?.name ?? null }; }
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
