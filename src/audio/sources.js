// AudioSource abstraction. The analysis pipeline only needs an identity and
// the encoded audio bytes, so new origins can plug in without touching it.
//
//   LocalFileSource – files chosen or dropped by the user.

import { hashArrayBuffer } from "../util/hash.js";

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
