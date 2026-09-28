// Spotify login with OAuth 2.0 Authorization Code + PKCE: the flow meant for
// apps without a server (no client secret exists in this app). The token
// stays in this browser (localStorage) and is only ever sent to Spotify.

const AUTH_URL = "https://accounts.spotify.com/authorize";
const TOKEN_URL = "https://accounts.spotify.com/api/token";
export const SCOPES = [
  "playlist-read-private",       // list and read your private playlists
  "playlist-read-collaborative", // … and collaborative ones
  "playlist-modify-private",     // create the sorted playlist (private by default)
  "playlist-modify-public",
  "user-read-playback-state",    // live scan: know which device plays what
  "user-modify-playback-state",  // live scan: play / pause / seek on your Spotify app
];
export const PLAYBACK_SCOPES = ["user-read-playback-state", "user-modify-playback-state"];
const TOKEN_KEY = "mea.spotify.token";
const CLIENT_KEY = "mea.spotify.clientId";
const PKCE_KEY = "mea.spotify.pkce";

const store = {
  get(k, session = false) {
    try { return JSON.parse((session ? sessionStorage : localStorage).getItem(k)); } catch { return null; }
  },
  set(k, v, session = false) {
    try { (session ? sessionStorage : localStorage).setItem(k, JSON.stringify(v)); } catch { /* storage blocked */ }
  },
  del(k, session = false) {
    try { (session ? sessionStorage : localStorage).removeItem(k); } catch { /* ignore */ }
  },
};

/** Redirect URI to register in the Spotify dashboard: this page's URL, without index.html. */
export function redirectUri() {
  return location.origin + location.pathname.replace(/index\.html$/, "");
}

export const getClientId = () => store.get(CLIENT_KEY) ?? "";
export function setClientId(id) {
  const v = String(id ?? "").trim();
  if (v && !/^[0-9a-f]{32}$/i.test(v)) throw new Error("Un Client ID Spotify fait 32 caractères hexadécimaux.");
  if (v) store.set(CLIENT_KEY, v);
  else store.del(CLIENT_KEY);
}

export const isLoggedIn = () => !!store.get(TOKEN_KEY)?.refresh_token || !!store.get(TOKEN_KEY)?.access_token;

/** True when the stored token was granted every scope in `list` (older logins lack the playback ones). */
export function hasScopes(list) {
  const granted = String(store.get(TOKEN_KEY)?.scope ?? "").split(/\s+/);
  return list.every((s) => granted.includes(s));
}

export function logout() {
  store.del(TOKEN_KEY);
  store.del(PKCE_KEY, true);
}

function base64url(bytes) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** PKCE pair: random verifier (43+ chars) and its S256 challenge. */
export async function pkcePair() {
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(64)));
  const challenge = await s256(verifier);
  return { verifier, challenge };
}

export async function s256(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return base64url(new Uint8Array(digest));
}

/** Leaves the page for Spotify's consent screen. */
export async function beginLogin() {
  const clientId = getClientId();
  if (!clientId) throw new Error("Renseigne d'abord le Client ID de ton application Spotify.");
  if (!globalThis.crypto?.subtle) throw new Error("Connexion impossible : page non sécurisée (il faut https ou 127.0.0.1).");
  const { verifier, challenge } = await pkcePair();
  const state = base64url(crypto.getRandomValues(new Uint8Array(16)));
  store.set(PKCE_KEY, { verifier, state, clientId, redirect: redirectUri() }, true);
  const url = new URL(AUTH_URL);
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    scope: SCOPES.join(" "),
    redirect_uri: redirectUri(),
    code_challenge_method: "S256",
    code_challenge: challenge,
    state,
  }).toString();
  location.assign(url.toString());
}

/**
 * Called on page load: finishes the login when Spotify redirected back here.
 * @returns {Promise<null | {ok:boolean, error?:string}>} null when the URL holds no Spotify answer
 */
export async function handleRedirect() {
  const params = new URLSearchParams(location.search);
  const code = params.get("code");
  const error = params.get("error");
  if (!code && !error) return null;
  const pending = store.get(PKCE_KEY, true);
  // remove code / state from the address bar and history
  history.replaceState(null, "", redirectUri() + location.hash);
  store.del(PKCE_KEY, true);
  if (error) return { ok: false, error: error === "access_denied" ? "Connexion refusée." : `Spotify : ${error}` };
  if (!pending || pending.state !== params.get("state")) return { ok: false, error: "Réponse de connexion inattendue (state invalide) : réessaie." };
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: pending.redirect,
      client_id: pending.clientId,
      code_verifier: pending.verifier,
    }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) return { ok: false, error: `Échec de la connexion : ${json.error_description || json.error || res.status}` };
  saveToken(json);
  return { ok: true };
}

function saveToken(json, previous = null) {
  store.set(TOKEN_KEY, {
    access_token: json.access_token,
    refresh_token: json.refresh_token ?? previous?.refresh_token,
    expires_at: Date.now() + (json.expires_in ?? 3600) * 1000,
    scope: json.scope ?? previous?.scope,
  });
}

/** A valid access token, refreshed when it is about to expire. */
export async function accessToken({ force = false } = {}) {
  const tok = store.get(TOKEN_KEY);
  if (!tok) throw new Error("Non connecté à Spotify.");
  if (!force && tok.access_token && tok.expires_at - Date.now() > 60_000) return tok.access_token;
  if (!tok.refresh_token) {
    logout();
    throw new Error("Session Spotify expirée : reconnecte-toi.");
  }
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: tok.refresh_token, client_id: getClientId() }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    logout();
    throw new Error("Session Spotify expirée : reconnecte-toi.");
  }
  saveToken(json, tok);
  return json.access_token;
}
