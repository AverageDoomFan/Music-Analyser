export function formatDuration(seconds) {
  if (seconds == null || !Number.isFinite(seconds)) return "—";
  const s = Math.round(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${r}` : `${m}:${r}`;
}

export function formatSize(bytes) {
  if (bytes == null) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

export const formatScore = (s) => (s == null ? "—" : String(Math.round(s)));

export function formatDelta(d) {
  if (d == null) return "—";
  const r = Math.round(d);
  if (r === 0) return "±0";
  return r > 0 ? `+${r}` : `−${Math.abs(r)}`;
}

export function formatDate(ts) {
  if (!ts) return "—";
  return new Date(ts).toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "short" });
}

export function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}
