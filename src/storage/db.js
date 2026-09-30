// Thin promise wrapper around IndexedDB. Three object stores:
//   tracks   – one record per audio file (keyPath: id = content hash)
//   settings – key/value pairs (weights, preferences)
//   listens  – listening log of the Live follow mode (auto-increment key, index "at")
//              added in version 2: the upgrade only creates missing stores, data is kept

import { t } from "../i18n/index.js";

const DB_NAME = "music-energy-analyzer";
const DB_VERSION = 2;

let dbPromise = null;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("tracks")) {
        const s = db.createObjectStore("tracks", { keyPath: "id" });
        s.createIndex("addedAt", "addedAt");
      }
      if (!db.objectStoreNames.contains("settings")) db.createObjectStore("settings", { keyPath: "key" });
      if (!db.objectStoreNames.contains("listens")) {
        const l = db.createObjectStore("listens", { keyPath: "id", autoIncrement: true });
        l.createIndex("at", "at");
      }
    };
    req.onsuccess = () => {
      // a newer version opened in another tab: let it upgrade
      req.result.onversionchange = () => { req.result.close(); dbPromise = null; };
      resolve(req.result);
    };
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error(t("IndexedDB database blocked by another tab.")));
  });
  return dbPromise;
}

function run(storeName, mode, fn) {
  return open().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, mode);
    const store = tx.objectStore(storeName);
    let result;
    const req = fn(store);
    if (req) req.onsuccess = () => { result = req.result; };
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  }));
}

export const db = {
  getTrack: (id) => run("tracks", "readonly", (s) => s.get(id)),
  getAllTracks: () => run("tracks", "readonly", (s) => s.getAll()),
  putTrack: (record) => run("tracks", "readwrite", (s) => s.put(record)),
  putTracks: (records) => run("tracks", "readwrite", (s) => { for (const r of records) s.put(r); }),
  deleteTrack: (id) => run("tracks", "readwrite", (s) => s.delete(id)),
  getSetting: (key) => run("settings", "readonly", (s) => s.get(key)).then((r) => r?.value),
  setSetting: (key, value) => run("settings", "readwrite", (s) => s.put({ key, value })),
  addListen: (entry) => run("listens", "readwrite", (s) => s.add(entry)),
  getAllListens: () => run("listens", "readonly", (s) => s.getAll()),
  putListens: (entries) => run("listens", "readwrite", (s) => { for (const e of entries) s.put(e); }),
  clearListens: () => run("listens", "readwrite", (s) => s.clear()),
  async clearAll() {
    await run("tracks", "readwrite", (s) => s.clear());
    await run("settings", "readwrite", (s) => s.clear());
    await run("listens", "readwrite", (s) => s.clear());
  },
};
