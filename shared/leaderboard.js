// Leaderboard client shared by all games.
// Same-origin /api by default; a portal build sets window.LEADERBOARD_URL to the hosted server,
// or to 'off' where outside requests are not allowed (the game then hides all leaderboard UI).

const BASE = String(window.LEADERBOARD_URL || '/api').replace(/\/$/, '');

async function call(path, options) {
  const res = await fetch(`${BASE}${path}`, options);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `Leaderboard error ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

const post = (path, body) =>
  call(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

export const Leaderboard = {
  enabled: window.LEADERBOARD_URL !== 'off',

  /** -> { top: [{ rank, name, score, level, me }], me, total } */
  top(game, playerId, limit = 50) {
    const q = new URLSearchParams({ limit: String(limit), player: playerId });
    return call(`/leaderboard/${game}?${q}`);
  },

  /** Server keeps each player's best score. -> { rank, score, level } */
  submit(game, { playerId, name, score, level }) {
    return post(`/leaderboard/${game}`, { playerId, name, score, level });
  },

  /** Throws with a readable message (err.status 400) if the server rejects the name. */
  checkName(game, name) {
    return post(`/leaderboard/${game}/name`, { name });
  },
};
