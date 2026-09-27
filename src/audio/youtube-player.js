// Minimal wrapper around the official YouTube IFrame Player API.

let apiPromise = null;

function loadApi() {
  apiPromise ??= new Promise((resolve, reject) => {
    if (window.YT?.Player) return resolve(window.YT);
    const previous = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      previous?.();
      resolve(window.YT);
    };
    const s = document.createElement("script");
    s.src = "https://www.youtube.com/iframe_api";
    s.onerror = () => {
      apiPromise = null;
      reject(new Error("Impossible de charger le lecteur YouTube (connexion ou bloqueur ?)."));
    };
    document.head.append(s);
  });
  return apiPromise;
}

const ERRORS = {
  2: "Identifiant de vidéo invalide.",
  5: "Lecture impossible dans ce navigateur.",
  100: "Vidéo introuvable ou privée.",
  101: "Le propriétaire de la vidéo n'autorise pas la lecture intégrée.",
  150: "Le propriétaire de la vidéo n'autorise pas la lecture intégrée.",
};

export const PLAYER_STATE = { ENDED: 0, PLAYING: 1, PAUSED: 2, BUFFERING: 3 };

/**
 * @param {HTMLElement} host
 * @param {string} videoId
 * @param {{onStateChange?:(state:number)=>void, onError?:(message:string)=>void}} handlers
 * @returns {Promise<YT.Player>}
 */
export async function createPlayer(host, videoId, { onStateChange = () => {}, onError = () => {} } = {}) {
  const YT = await loadApi();
  host.innerHTML = "";
  const el = document.createElement("div");
  host.append(el);
  return new Promise((resolve) => {
    const player = new YT.Player(el, {
      videoId,
      width: "100%",
      height: "100%",
      playerVars: { playsinline: 1, rel: 0, modestbranding: 1 },
      events: {
        onReady: () => {
          player.setVolume(100);
          player.unMute();
          resolve(player);
        },
        onStateChange: (e) => onStateChange(e.data),
        onError: (e) => onError(ERRORS[e.data] ?? `Erreur du lecteur YouTube (${e.data}).`),
      },
    });
  });
}
