// Thirsty Town (internal id: driplink) - rotate pipe tiles until water from the tap reaches every tile.
// Endless run: every board is freshly random, and each win makes the next one bigger.

import { Platform, store } from './shared/platform.js';
import { Leaderboard } from './shared/leaderboard.js';

const GAME_ID = 'driplink';
const SAVE_KEY = 'driplink.v2';
const AD_EVERY_LEVELS = 2; // interstitial after this many wins...
const AD_MIN_GAP_MS = 30_000; // ...but never more often than this
const HINT_PENALTY = 0.25; // share of a board's points each hint costs

// ---------- puzzle model ----------

const N = 1, E = 2, S = 4, W = 8;
const DIRS = [
  { bit: N, dx: 0, dy: -1, opp: S },
  { bit: E, dx: 1, dy: 0, opp: W },
  { bit: S, dx: 0, dy: 1, opp: N },
  { bit: W, dx: -1, dy: 0, opp: E },
];
const rotCW = (m) => ((m << 1) | (m >> 3)) & 15;
const rotCCW = (m) => ((m >> 1) | (m << 3)) & 15;
const degree = (m) => (m & 1) + ((m >> 1) & 1) + ((m >> 2) & 1) + ((m >> 3) & 1);

function mulberry32(seed) {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function newSeed() {
  try {
    return crypto.getRandomValues(new Uint32Array(1))[0];
  } catch {
    return (Math.random() * 2 ** 32) >>> 0;
  }
}

function newPlayerId() {
  try {
    if (crypto.randomUUID) return crypto.randomUUID();
  } catch {}
  return `p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Difficulty curve: one side grows every ~2-3 wins.
 * 3x3, 3x3, 3x3, 4x3, 4x3, 4x4 ... 10x10 from level 36 on.
 */
function boardSize(level) {
  const k = Math.max(0, level - 1);
  return {
    long: Math.min(10, 3 + Math.floor((k + 2) / 5)),
    short: Math.min(10, 3 + Math.floor(k / 5)),
  };
}

function generate(level, seed, landscape) {
  const rand = mulberry32(seed);
  const { long, short } = boardSize(level);
  const w = landscape ? long : short;
  const h = landscape ? short : long;
  const n = w * h;
  const src = Math.floor(h / 2) * w + Math.floor(w / 2);

  // Random spanning tree (randomized Prim) - every tile ends up connected to the tap.
  const sol = new Array(n).fill(0);
  const inTree = new Array(n).fill(false);
  const frontier = [];
  const addEdges = (i) => {
    const x = i % w, y = (i / w) | 0;
    for (const d of DIRS) {
      const nx = x + d.dx, ny = y + d.dy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const j = ny * w + nx;
      if (!inTree[j]) frontier.push([i, j, d]);
    }
  };
  inTree[src] = true;
  addEdges(src);
  while (frontier.length) {
    const k = (rand() * frontier.length) | 0;
    const [i, j, d] = frontier[k];
    frontier[k] = frontier[frontier.length - 1];
    frontier.pop();
    if (inTree[j]) continue;
    // Avoid 4-way crosses (they can't be rotated, so they're free tiles)
    // unless there is no other way to reach this tile.
    if (degree(sol[i]) >= 3 && frontier.some((f) => f[1] === j && degree(sol[f[0]]) < 3)) continue;
    sol[i] |= d.bit;
    sol[j] |= d.opp;
    inTree[j] = true;
    addEdges(j);
  }

  const tiles = sol.map((m) => {
    let t = m;
    for (let q = (rand() * 4) | 0; q > 0; q--) t = rotCW(t);
    return t;
  });

  const state = { w, h, src, sol, tiles, par: 0 };
  // A scramble can land on the solution by chance; rotate one tile so it can't.
  if (isSolved(state, flood(state))) {
    const i = tiles.findIndex((m, idx) => idx !== src && rotCW(m) !== m);
    tiles[i] = rotCCW(tiles[i]);
  }
  // Fewest taps to solve (taps turn clockwise): the 3-star target.
  for (let i = 0; i < n; i++) {
    let t = tiles[i], k = 0;
    while (t !== sol[i] && k < 4) { t = rotCW(t); k++; }
    state.par += k;
  }
  return state;
}

/** Tiles water reaches from the tap through connections that match on both sides. */
function flood(s) {
  const filled = new Uint8Array(s.w * s.h);
  const stack = [s.src];
  filled[s.src] = 1;
  while (stack.length) {
    const i = stack.pop();
    const x = i % s.w, y = (i / s.w) | 0;
    for (const d of DIRS) {
      if (!(s.tiles[i] & d.bit)) continue;
      const nx = x + d.dx, ny = y + d.dy;
      if (nx < 0 || ny < 0 || nx >= s.w || ny >= s.h) continue;
      const j = ny * s.w + nx;
      if (filled[j] || !(s.tiles[j] & d.opp)) continue;
      filled[j] = 1;
      stack.push(j);
    }
  }
  return filled;
}

/** For each watered tile: steps from the tap, and the side the water comes in from. */
function flowMap(s) {
  const n = s.w * s.h;
  const dist = new Int16Array(n).fill(-1);
  const from = new Uint8Array(n);
  const queue = [s.src];
  dist[s.src] = 0;
  for (let q = 0; q < queue.length; q++) {
    const i = queue[q];
    const x = i % s.w, y = (i / s.w) | 0;
    for (const d of DIRS) {
      if (!(s.tiles[i] & d.bit)) continue;
      const nx = x + d.dx, ny = y + d.dy;
      if (nx < 0 || ny < 0 || nx >= s.w || ny >= s.h) continue;
      const j = ny * s.w + nx;
      if (dist[j] >= 0 || !(s.tiles[j] & d.opp)) continue;
      dist[j] = dist[i] + 1;
      from[j] = d.opp;
      queue.push(j);
    }
  }
  return { dist, from };
}

/** Solved = water reaches every tile and no pipe end is left open. */
function isSolved(s, filled) {
  for (let i = 0; i < s.w * s.h; i++) {
    if (!filled[i]) return false;
    const x = i % s.w, y = (i / s.w) | 0;
    for (const d of DIRS) {
      if (!(s.tiles[i] & d.bit)) continue;
      const nx = x + d.dx, ny = y + d.dy;
      if (nx < 0 || ny < 0 || nx >= s.w || ny >= s.h) return false;
      if (!(s.tiles[ny * s.w + nx] & d.opp)) return false;
    }
  }
  return true;
}

// ---------- scoring ----------

/** 3 stars up to `three` taps, 2 stars up to `two`, 1 star beyond. */
const starLimits = (par) => ({ three: par, two: Math.ceil(par * 1.5) });

function starsFor(moves, par) {
  const lim = starLimits(par);
  return moves <= lim.three ? 3 : moves <= lim.two ? 2 : 1;
}

function pointsFor(g, stars) {
  const base = g.w * g.h * 10;
  const cut = Math.min(0.75, g.hints * HINT_PENALTY);
  return { base, stars, cut, total: Math.round(base * stars * (1 - cut)) };
}

const fmt = (n) => n.toLocaleString('en-US');
const starsHtml = (n) => `<span class="on">${'★'.repeat(n)}</span><span class="off">${'★'.repeat(3 - n)}</span>`;

// ---------- app state ----------

const $ = (id) => document.getElementById(id);
const canvas = $('board');
const ctx = canvas.getContext('2d');

const save = store.load(SAVE_KEY, {
  run: null, // { level, score, seed, landscape } - the endless run in progress
  best: 0,
  bestLevel: 0,
  name: '',
  playerId: '',
  tutorialSeen: false,
  muted: false,
});
if (!save.playerId) save.playerId = newPlayerId();
const persist = () => store.save(SAVE_KEY, save);
persist();

let game = null; // the board on screen
let levelsSinceAd = 0;
let lastAdAt = 0;
const view = { cell: 0, ox: 0, oy: 0, cw: 0, ch: 0, dpr: 1 };
let dirty = true;

// Animation timing (seconds).
const REDUCED = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
const FILL_TIME = 0.16; // water crossing one tile
const FLOW_STEP = 0.07; // delay between neighbouring tiles as water spreads
const INTRO_TIME = 0.3; // a tile popping in at level start
const clock = () => performance.now() / 1000;
const clamp01 = (v) => Math.max(0, Math.min(1, v));
let now = clock(); // time of the current frame
let still = false; // debug: screenshots want finished animations

/** Restart a one-shot CSS animation on an element. */
function bump(el, cls = 'bump') {
  el.classList.remove(cls);
  void el.offsetWidth;
  el.classList.add(cls);
}

/** Count a number up inside an element. */
function countUp(el, to, render, delay = 0, dur = 700) {
  const id = (el._count = (el._count || 0) + 1);
  if (REDUCED || still) return void (el.textContent = render(to));
  el.textContent = render(0);
  const t0 = performance.now() + delay;
  const tick = (t) => {
    if (el._count !== id) return;
    const k = clamp01((t - t0) / dur);
    el.textContent = render(Math.round(to * (1 - (1 - k) ** 3)));
    if (k < 1) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

const isLandscape = () => window.innerWidth > window.innerHeight;

function newRun({ anonymous = false } = {}) {
  save.run = { level: 1, score: 0, seed: newSeed(), landscape: isLandscape(), anonymous };
  persist();
  startLevel();
  if (!save.tutorialSeen) openHowTo();
}

function openHowTo() {
  show('howto');
}

function closeHowTo() {
  hide('howto');
  if (!save.tutorialSeen) {
    save.tutorialSeen = true;
    persist();
  }
}

function startLevel() {
  const run = save.run;
  const g = generate(run.level, run.seed, run.landscape);
  const n = g.w * g.h;
  game = {
    ...g, level: run.level, seed: run.seed, locked: new Uint8Array(n), moves: 0, hints: 0, solved: false,
    anim: new Float32Array(n), // rotation still to play, radians
    wet: new Float32Array(n), // how far water has filled the tile, 0..1
    wetDelay: new Float32Array(n), // seconds before the tile starts filling
    press: new Float32Array(n), // tap dip, 1 -> 0
    pop: new Float32Array(n), // house jump, 1 -> 0
    introDelay: new Float32Array(n),
    waved: new Uint8Array(n),
    fx: [], rings: [],
    t0: clock(), winAt: null, waveStep: 0, srcTimer: 1.4,
  };
  // Tiles pop in outwards from the tap, then the water starts running.
  const sx = g.src % g.w, sy = (g.src / g.w) | 0;
  let far = 1;
  for (let i = 0; i < n; i++) {
    game.introDelay[i] = Math.abs((i % g.w) - sx) + Math.abs(((i / g.w) | 0) - sy);
    far = Math.max(far, game.introDelay[i]);
  }
  const introStep = Math.min(0.045, 0.35 / far);
  for (let i = 0; i < n; i++) game.introDelay[i] *= introStep;
  game.filled = flood(game);
  syncWater(null);
  if (!REDUCED) for (let i = 0; i < n; i++) game.wetDelay[i] += far * introStep + INTRO_TIME * 0.5;
  hideOverlays();
  updateHud();
  bump($('lvl'));
  layout();
  Platform.gameplayStart();
}

/**
 * Called after the flood changes. Newly reached tiles fill one after another, in order of
 * distance from the tap. Returns how long that takes, in seconds.
 */
function syncWater(prev) {
  const { dist, from } = flowMap(game);
  game.dist = dist;
  game.from = from;
  const n = game.tiles.length;
  if (REDUCED) {
    for (let i = 0; i < n; i++) game.wet[i] = game.filled[i];
    return 0;
  }
  let first = Infinity, lastD = 0;
  for (let i = 0; i < n; i++) {
    if (!game.filled[i] || prev?.[i]) continue;
    first = Math.min(first, dist[i]);
    lastD = Math.max(lastD, dist[i]);
  }
  if (first === Infinity) return 0;
  const stepTime = Math.min(FLOW_STEP, 0.7 / Math.max(1, lastD - first));
  for (let i = 0; i < n; i++) {
    if (!game.filled[i] || prev?.[i]) continue;
    game.wet[i] = 0;
    game.wetDelay[i] = (dist[i] - first) * stepTime;
  }
  return (lastD - first) * stepTime + FILL_TIME;
}

function updateHud() {
  if (!game || !save.run) return;
  $('lvl').textContent = `Level ${game.level}`;
  $('score').textContent = `${fmt(save.run.score)} pts`;
  const stars = starsFor(game.moves, game.par);
  const lim = starLimits(game.par);
  const cap = stars === 3 ? lim.three : stars === 2 ? lim.two : 0;
  const taps = cap ? `${game.moves} / ${cap} taps` : `${game.moves} taps`;
  $('meter').innerHTML = `${starsHtml(stars)} · ${taps}`;
  if (game.lastStars && stars < game.lastStars) bump($('meter'), 'shake');
  game.lastStars = stars;
}

function rotate(i, dir) {
  if (!game || game.solved || game.locked[i]) return;
  game.tiles[i] = dir > 0 ? rotCW(game.tiles[i]) : rotCCW(game.tiles[i]);
  // Draw from the previous orientation and spin towards the new one.
  game.anim[i] += dir > 0 ? -Math.PI / 2 : Math.PI / 2;
  game.moves++;
  game.press[i] = 1;
  ring(i, '#ffffff', 0.5, 0.3);
  sfx.click();
  afterChange();
}

function afterChange() {
  const prev = game.filled;
  game.filled = flood(game);
  const flowTime = syncWater(prev);
  updateHud();
  dirty = true;
  if (isSolved(game, game.filled)) return win(flowTime);
  checkHousesDone();
}

/** Pipe ends on tile i that don't meet a matching pipe (point at a wall or a closed side). */
function openEnds(i) {
  const x = i % game.w, y = (i / game.w) | 0;
  let n = 0;
  for (const d of DIRS) {
    if (!(game.tiles[i] & d.bit)) continue;
    const nx = x + d.dx, ny = y + d.dy;
    if (nx < 0 || ny < 0 || nx >= game.w || ny >= game.h || !(game.tiles[ny * game.w + nx] & d.opp)) n++;
  }
  return n;
}

/**
 * The common "why didn't I win?" moment: every house has water but some pipes are dry
 * or leak. Then we highlight the problem tiles and say so once per board.
 */
function checkHousesDone() {
  let housesDone = true;
  for (let i = 0; i < game.tiles.length; i++) {
    if (i !== game.src && degree(game.tiles[i]) === 1 && !game.filled[i]) {
      housesDone = false;
      break;
    }
  }
  game.problems = null;
  if (!housesDone) return;
  game.problems = new Uint8Array(game.tiles.length);
  let dry = 0, leaks = 0;
  for (let i = 0; i < game.tiles.length; i++) {
    if (!game.filled[i]) { game.problems[i] = 1; dry++; }
    else if (openEnds(i)) { game.problems[i] = 1; leaks++; }
  }
  if (game.nudged) return;
  game.nudged = true;
  toast(
    dry
      ? `All houses have water! But ${dry} ${dry === 1 ? 'pipe is' : 'pipes are'} still dry. Every pipe must carry water.`
      : `All houses have water! Now close the ${leaks === 1 ? 'open pipe end' : 'open pipe ends'}.`,
    4500,
  );
}

function win(flowTime = 0) {
  game.solved = true;
  // Let the last water arrive, then send a wave across the board, then show the result.
  const far = Math.max(1, ...game.dist);
  game.waveStep = Math.min(0.05, 0.5 / far);
  game.winAt = clock() + flowTime + 0.1;
  const waveAt = (flowTime + 0.1) * 1000;
  const overlayAt = REDUCED ? 650 : waveAt + (far * game.waveStep + 0.65) * 1000;
  Platform.gameplayStop();
  const run = save.run;
  const stars = starsFor(game.moves, game.par);
  const pts = pointsFor(game, stars);

  run.score += pts.total;
  save.best = Math.max(save.best, run.score);
  save.bestLevel = Math.max(save.bestLevel, game.level);
  // Advance now, so a reload continues on the next board.
  run.level = game.level + 1;
  run.seed = newSeed();
  run.landscape = isLandscape();
  persist();
  levelsSinceAd++;
  setTimeout(sfx.win, REDUCED ? 0 : waveAt);
  $('score').textContent = `${fmt(run.score)} pts`;
  bump($('score'));

  $('win-title').textContent = `Level ${game.level} complete`;
  $('win-stars').innerHTML = [0, 1, 2]
    .map((k) => `<span class="star ${k < stars ? 'on' : 'off'}" style="--i:${k}">★</span>`)
    .join('');
  const rows = [
    [`Board ${game.w}×${game.h}`, `${fmt(pts.base)} pts`],
    [`${'★'.repeat(stars)} ${stars === 1 ? 'star' : 'stars'}`, `×${stars}`],
  ];
  if (pts.cut) rows.push([`${game.hints} ${game.hints === 1 ? 'hint' : 'hints'}`, `−${Math.round(pts.cut * 100)}%`]);
  const box = $('win-breakdown');
  box.replaceChildren(
    ...rows.map(([label, value]) => {
      const row = document.createElement('div');
      const a = document.createElement('span');
      const b = document.createElement('span');
      a.textContent = label;
      b.textContent = value;
      row.append(a, b);
      return row;
    }),
  );
  $('win-points').textContent = `+${fmt(pts.total)}`;
  const solvedGame = game;
  $('win-total').textContent = `Total: ${fmt(run.score)} pts`;
  $('win-tip').textContent =
    stars === 3
      ? 'Perfect: fewest possible taps!'
      : `★★★ needed ${game.par} taps or fewer. You used ${game.moves}.`;
  $('win-rank').textContent = '';
  submitScore(run.score, game.level);
  setTimeout(() => {
    if (game !== solvedGame) return; // the player has already moved on
    show('win');
    countUp($('win-points'), pts.total, (v) => `+${fmt(v)}`, 700);
  }, overlayAt);
}

async function submitScore(score, level) {
  $('win-leaders').replaceChildren();
  if (!Leaderboard.enabled) return;
  const ranked = !save.run.anonymous && save.name;
  if (save.run.anonymous) {
    $('win-rank').textContent = 'Playing without a name: this run is not on the leaderboard.';
  } else if (!save.name) {
    $('win-rank').textContent = 'Set your name in the menu to join the leaderboard.';
  } else {
    try {
      const r = await Leaderboard.submit(GAME_ID, { playerId: save.playerId, name: save.name, score, level });
      $('win-rank').textContent = `🏆 Your best is #${r.rank} on the leaderboard`;
    } catch (err) {
      console.warn(err);
      $('win-rank').textContent = 'Leaderboard is offline. Your score is saved on this device.';
      return;
    }
  }
  // Top 5, plus the player's own row underneath if they're further down.
  try {
    const data = await Leaderboard.top(GAME_ID, save.playerId, 5);
    const rows = data.top.map((r) => ({ ...r, me: ranked && r.me }));
    if (ranked && data.me && !data.top.some((r) => r.me)) rows.push(data.me);
    renderLeaderRows($('win-leaders'), rows);
  } catch (err) {
    console.warn(err);
  }
}

function renderLeaderRows(list, rows) {
  list.replaceChildren(
    ...rows.map((r) => {
      const li = document.createElement('li');
      if (r.me) li.className = 'me';
      const cells = [
        ['rank', `#${r.rank}`],
        ['name', r.name],
        ['lv', `lvl ${r.level}`],
        ['sc', fmt(r.score)],
      ];
      for (const [cls, text] of cells) {
        const span = document.createElement('span');
        span.className = cls;
        span.textContent = text;
        li.appendChild(span);
      }
      return li;
    }),
  );
}

async function nextLevel() {
  hide('win');
  if (levelsSinceAd >= AD_EVERY_LEVELS && Date.now() - lastAdAt >= AD_MIN_GAP_MS) {
    await Platform.interstitial();
    lastAdAt = Date.now();
    levelsSinceAd = 0;
  }
  startLevel();
}

async function hint() {
  if (!game || game.solved) return;
  const wrong = [];
  for (let i = 0; i < game.tiles.length; i++) {
    if (!game.locked[i] && game.tiles[i] !== game.sol[i]) wrong.push(i);
  }
  if (!wrong.length) return toast('Every pipe is already in place');
  Platform.gameplayStop();
  const granted = await Platform.rewarded();
  Platform.gameplayStart();
  if (!granted) return toast('No hint this time');
  const i = wrong[(Math.random() * wrong.length) | 0];
  game.tiles[i] = game.sol[i];
  game.locked[i] = 1;
  game.hints++;
  game.anim[i] = Math.PI * 2;
  ring(i, COLORS.gold, 0.85, 0.6);
  splash(i, 8, [COLORS.gold, '#ffffff'], 0.8);
  toast(`Hint used: this board pays ${Math.round(Math.min(0.75, game.hints * HINT_PENALTY) * 100)}% less`);
  afterChange();
}

// ---------- menu & dialogs ----------

const OVERLAYS = ['menu', 'win', 'howto', 'confirm', 'name-dlg', 'leaders'];
function show(id) { $(id).classList.remove('hidden'); }
function hide(id) { $(id).classList.add('hidden'); }
function hideOverlays() { OVERLAYS.forEach(hide); }

function openMenu() {
  if (game && !game.solved) Platform.gameplayStop();
  const run = save.run;
  const cont = $('btn-continue');
  cont.classList.toggle('hidden', !run);
  if (run) cont.textContent = `Continue · Level ${run.level} · ${fmt(run.score)} pts`;
  $('btn-new').className = run ? 'secondary wide' : 'primary wide';
  $('btn-name').textContent = save.name ? `Player: ${save.name} ✎` : 'Set your name for the leaderboard';
  $('btn-name').classList.toggle('hidden', !Leaderboard.enabled);
  $('btn-leaders').classList.toggle('hidden', !Leaderboard.enabled);
  $('best').textContent = save.best ? `Your best: ${fmt(save.best)} pts · reached level ${save.bestLevel}` : '';
  $('btn-sound').textContent = `Sound: ${progressSound()}`;
  hideOverlays();
  show('menu');
}

const progressSound = () => (save.muted ? 'off' : 'on');

function continueRun() {
  // Same board still on screen: just resume it, keeping the taps made so far.
  if (game && !game.solved && game.seed === save.run.seed) {
    hideOverlays();
    Platform.gameplayStart();
    return;
  }
  startLevel();
}

function askNewGame() {
  const run = save.run;
  if (!run || (run.level === 1 && run.score === 0)) return askNameThenStart();
  $('confirm-text').textContent =
    `Your current run (level ${run.level}, ${fmt(run.score)} pts) will be lost.` +
    (Leaderboard.enabled ? ' Your best score stays on the leaderboard.' : '');
  show('confirm');
}

/** Every new run starts by asking who is playing (prefilled with the last name). */
function askNameThenStart() {
  hide('confirm');
  if (!Leaderboard.enabled) return newRun({ anonymous: true });
  openName((named) => newRun({ anonymous: !named }));
}

let afterName = null; // what to do once the name dialog closes (start a run, or nothing)

function openName(then = null) {
  afterName = then;
  $('name-input').value = save.name;
  $('name-err').textContent = '';
  $('btn-name-save').textContent = then ? 'Start game' : 'Save';
  $('btn-name-skip').textContent = then ? 'Play without a name' : 'Cancel';
  show('name-dlg');
  setTimeout(() => $('name-input').focus(), 50);
}

/** named: true when the player saved a name, false when they skipped. */
function closeName(named = false) {
  hide('name-dlg');
  const then = afterName;
  afterName = null;
  then?.(named);
}

async function saveName() {
  const name = $('name-input').value.trim().replace(/\s+/g, ' ');
  if (!/^[\p{L}\p{N} _.-]{2,16}$/u.test(name)) {
    $('name-err').textContent = 'Use 2-16 letters, numbers, spaces, _ . -';
    return;
  }
  $('btn-name-save').disabled = true;
  try {
    await Leaderboard.checkName(GAME_ID, name);
  } catch (err) {
    if (err.status === 400) {
      $('name-err').textContent = err.message;
      $('btn-name-save').disabled = false;
      return;
    }
    // Server unreachable: keep the name locally, it will be sent with the next score.
  }
  $('btn-name-save').disabled = false;
  // Scores are sent on the next win; earlier (possibly anonymous) results are not backfilled.
  save.name = name;
  persist();
  $('btn-name').textContent = `Player: ${save.name} ✎`;
  // Naming yourself mid-run puts that run back on the leaderboard.
  if (save.run) save.run.anonymous = false;
  persist();
  closeName(true);
}

async function openLeaders() {
  const list = $('leaders-list');
  list.replaceChildren();
  $('leaders-status').textContent = 'Loading…';
  $('leaders-me').textContent = '';
  show('leaders');
  try {
    const data = await Leaderboard.top(GAME_ID, save.playerId, 50);
    $('leaders-status').textContent = data.top.length ? `${fmt(data.total)} players` : 'No scores yet. Be the first!';
    renderLeaderRows(list, data.top);
    if (data.me && !data.top.some((r) => r.me)) {
      $('leaders-me').textContent = `You: #${data.me.rank} · ${fmt(data.me.score)} pts`;
    } else if (!data.me) {
      $('leaders-me').textContent = save.name
        ? 'Win a level to get on the board.'
        : 'Set your name in the menu, then win a level to get on the board.';
    }
  } catch (err) {
    console.warn(err);
    $('leaders-status').textContent = 'The leaderboard is offline right now.';
  }
}

let toastTimer = 0;
function toast(text, ms = 2200) {
  const el = $('toast');
  el.textContent = text;
  show('toast');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => hide('toast'), ms);
}

// ---------- sound (generated, no audio files) ----------

let actx = null;
let adPlaying = false;
function tone(freq, dur, type = 'triangle', vol = 0.07, delay = 0) {
  if (save.muted || adPlaying) return;
  try {
    actx ??= new (window.AudioContext || window.webkitAudioContext)();
    const t0 = actx.currentTime + delay;
    const o = actx.createOscillator();
    const g = actx.createGain();
    o.type = type;
    o.frequency.value = freq;
    g.gain.setValueAtTime(vol, t0);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g).connect(actx.destination);
    o.start(t0);
    o.stop(t0 + dur);
  } catch {}
}
const sfx = {
  click: () => tone(520 + Math.random() * 80, 0.05),
  win: () => [523, 659, 784, 1047].forEach((f, k) => tone(f, 0.18, 'sine', 0.08, k * 0.09)),
};

// ---------- rendering ----------

const COLORS = {
  tile: '#1a2a42',
  tileLocked: '#24395e',
  tileSolved: '#173a4a',
  dry: '#5b6b82',
  water: '#3ec5ff',
  sourceBg: '#f2f8ff',
  sourceDrop: '#1793e6',
  houseDry: '#8a96a8',
  houseWet: '#7bed9f',
  windowLit: '#fff6c9',
  problem: '#ff9f43',
  gold: '#ffc94d',
};

const rgbCache = {};
const rgb = (hex) => (rgbCache[hex] ??= [1, 3, 5].map((k) => parseInt(hex.slice(k, k + 2), 16)));
function mix(a, b, t) {
  const A = rgb(a), B = rgb(b);
  return `rgb(${A.map((v, k) => Math.round(v + (B[k] - v) * t)).join(',')})`;
}
const easeOutBack = (k) => 1 + 2.7 * (k - 1) ** 3 + 1.7 * (k - 1) ** 2;
const easeOut = (k) => 1 - (1 - k) ** 3;

function layout() {
  const r = canvas.getBoundingClientRect();
  view.dpr = Math.min(window.devicePixelRatio || 1, 3);
  view.cw = r.width;
  view.ch = r.height;
  canvas.width = Math.round(r.width * view.dpr);
  canvas.height = Math.round(r.height * view.dpr);
  if (game) {
    const margin = 12;
    // Can be 0 while the canvas has no size yet (hidden pane, mid-resize); draw() skips then.
    view.cell = Math.max(0, Math.floor(Math.min(110, (r.width - margin * 2) / game.w, (r.height - margin * 2) / game.h)));
    view.ox = Math.round((r.width - view.cell * game.w) / 2);
    view.oy = Math.round((r.height - view.cell * game.h) / 2);
  }
  dirty = true;
}

function roundRect(x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

const tileX = (i) => view.ox + ((i % game.w) + 0.5) * view.cell;
const tileY = (i) => view.oy + (((i / game.w) | 0) + 0.5) * view.cell;

// ---------- effects ----------

/** Expanding ring on a tile. size is the final radius in cells. */
function ring(i, color, size = 0.6, life = 0.45) {
  if (REDUCED || !game) return;
  game.rings.push({ i, color, size, life, age: 0 });
}

/** Droplets thrown up from a tile. */
function splash(i, count, colors, power = 1) {
  if (REDUCED || !game || game.fx.length > 400) return;
  const c = view.cell;
  for (let k = 0; k < count; k++) {
    const a = -Math.PI / 2 + (Math.random() - 0.5) * 2.4;
    const v = c * (2 + Math.random() * 2.8) * power;
    game.fx.push({
      x: tileX(i),
      y: tileY(i),
      vx: Math.cos(a) * v,
      vy: Math.sin(a) * v,
      age: 0,
      life: 0.45 + Math.random() * 0.4,
      r: c * (0.03 + Math.random() * 0.04),
      color: colors[(Math.random() * colors.length) | 0],
    });
  }
}

/** Water has just filled tile i. */
function arrived(i) {
  if (i === game.src || degree(game.tiles[i]) !== 1) return;
  game.pop[i] = 1;
  ring(i, COLORS.houseWet, 0.7, 0.5);
  splash(i, 5, [COLORS.water, COLORS.houseWet], 0.7);
}

/** Advance every animation by dt seconds. */
function step(dt) {
  const g = game;
  const n = g.anim.length;
  for (let i = 0; i < n; i++) {
    let a = g.anim[i];
    if (a !== 0) {
      a -= a * (1 - Math.exp(-dt * 20));
      g.anim[i] = Math.abs(a) < 0.01 ? 0 : a;
    }
    if (g.press[i] > 0) g.press[i] = Math.max(0, g.press[i] - dt / 0.2);
    if (g.pop[i] > 0) g.pop[i] = Math.max(0, g.pop[i] - dt / 0.45);
    if (g.filled[i]) {
      if (g.wet[i] < 1) {
        if (g.wetDelay[i] > 0) g.wetDelay[i] -= dt;
        else {
          g.wet[i] = Math.min(1, g.wet[i] + dt / FILL_TIME);
          if (g.wet[i] === 1) arrived(i);
        }
      }
    } else if (g.wet[i] > 0) {
      g.wet[i] = Math.max(0, g.wet[i] - dt / 0.18);
    }
  }

  // The tap breathes out a ring every few seconds while the board is unsolved.
  if (!g.solved) {
    g.srcTimer -= dt;
    if (g.srcTimer <= 0) {
      g.srcTimer = 2.6;
      ring(g.src, COLORS.water, 0.8, 0.9);
    }
  }

  // Win wave: tiles bump outwards from the tap, houses throw confetti.
  if (g.winAt !== null && !REDUCED) {
    const tw = now - g.winAt;
    for (let i = 0; i < n; i++) {
      if (g.waved[i] || tw < g.dist[i] * g.waveStep) continue;
      g.waved[i] = 1;
      if (i !== g.src && degree(g.tiles[i]) === 1) {
        g.pop[i] = 1;
        splash(i, 7, [COLORS.water, COLORS.gold, COLORS.houseWet, '#ffffff'], 1.15);
      }
    }
  }

  const grav = view.cell * 13;
  for (const p of g.fx) {
    p.age += dt;
    p.vy += grav * dt;
    p.x += p.vx * dt;
    p.y += p.vy * dt;
  }
  if (g.fx.length) g.fx = g.fx.filter((p) => p.age < p.life);
  for (const r of g.rings) r.age += dt;
  if (g.rings.length) g.rings = g.rings.filter((r) => r.age < r.life);
}

function drawTile(i, T) {
  const c = view.cell;
  const mask = game.tiles[i];
  const wet = game.wet[i];
  const full = wet >= 1;

  // Scale: pop in at level start, dip on tap, bump when the win wave passes.
  const k = REDUCED ? 1 : clamp01((T - game.t0 - game.introDelay[i]) / INTRO_TIME);
  if (k <= 0) return;
  let scale = k < 1 ? easeOutBack(k) : 1;
  scale *= 1 - 0.08 * Math.sin(Math.PI * game.press[i]);
  let solvedMix = 0;
  if (game.winAt !== null) {
    solvedMix = REDUCED ? 1 : clamp01((T - game.winAt - game.dist[i] * game.waveStep) / 0.3);
    scale *= 1 + 0.1 * Math.sin(Math.PI * solvedMix);
  }
  const alpha = Math.min(1, k * 1.6);

  ctx.save();
  ctx.translate(tileX(i), tileY(i));
  ctx.scale(scale, scale);
  ctx.globalAlpha = alpha;

  const pad = Math.max(1, c * 0.04);
  const half = c / 2 - pad;
  const base = game.locked[i] ? COLORS.tileLocked : COLORS.tile;
  ctx.fillStyle = solvedMix ? mix(base, COLORS.tileSolved, solvedMix) : base;
  roundRect(-half, -half, half * 2, half * 2, c * 0.14);
  ctx.fill();
  if (game.problems?.[i]) {
    ctx.globalAlpha = alpha * (REDUCED ? 1 : 0.6 + 0.4 * Math.sin(T * 6));
    ctx.strokeStyle = COLORS.problem;
    ctx.lineWidth = Math.max(2, c * 0.05);
    ctx.stroke();
    ctx.globalAlpha = alpha;
  }

  ctx.rotate(game.anim[i]);

  const pipe = c * 0.22;
  ctx.lineWidth = pipe;
  ctx.lineCap = 'butt';
  const arms = () => {
    ctx.beginPath();
    for (const d of DIRS) {
      if (!(mask & d.bit)) continue;
      ctx.moveTo(0, 0);
      ctx.lineTo((d.dx * c) / 2, (d.dy * c) / 2);
    }
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(0, 0, pipe / 2, 0, Math.PI * 2);
    ctx.fill();
  };

  if (!full) {
    ctx.strokeStyle = ctx.fillStyle = COLORS.dry;
    arms();
  }
  if (wet > 0) {
    ctx.strokeStyle = ctx.fillStyle = COLORS.water;
    if (full) {
      arms();
    } else if (!game.filled[i]) {
      // Cut off from the tap: the water fades away.
      ctx.globalAlpha = alpha * wet;
      arms();
      ctx.globalAlpha = alpha;
    } else {
      // Filling: water runs in from the neighbour, through the middle, then out the other arms.
      const from = i === game.src ? 0 : game.from[i];
      const inP = from ? clamp01(wet * 2) : 1;
      const outP = from ? clamp01(wet * 2 - 1) : wet;
      ctx.beginPath();
      for (const d of DIRS) {
        if (!(mask & d.bit)) continue;
        const ex = (d.dx * c) / 2, ey = (d.dy * c) / 2;
        if (d.bit === from) {
          ctx.moveTo(ex, ey);
          ctx.lineTo(ex * (1 - inP), ey * (1 - inP));
        } else if (outP > 0) {
          ctx.moveTo(0, 0);
          ctx.lineTo(ex * outP, ey * outP);
        }
      }
      ctx.stroke();
      if (!from || wet >= 0.5) {
        ctx.beginPath();
        ctx.arc(0, 0, pipe / 2, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  // Current: light dashes that travel away from the tap.
  if (full && !REDUCED) {
    const from = i === game.src ? 0 : game.from[i];
    ctx.strokeStyle = 'rgba(255,255,255,0.32)';
    ctx.lineWidth = pipe * 0.26;
    ctx.lineCap = 'round';
    ctx.setLineDash([c * 0.08, c * 0.42]);
    ctx.lineDashOffset = -((T * 1.5) % 1) * c * 0.5;
    ctx.beginPath();
    for (const d of DIRS) {
      if (!(mask & d.bit)) continue;
      const ex = (d.dx * c) / 2, ey = (d.dy * c) / 2;
      if (d.bit === from) {
        ctx.moveTo(ex, ey);
        ctx.lineTo(0, 0);
      } else {
        ctx.moveTo(0, 0);
        ctx.lineTo(ex, ey);
      }
    }
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.lineCap = 'butt';
  }

  if (i === game.src) {
    // Water source: a white valve badge with a big drop. Stays upright while the pipe spins.
    ctx.rotate(-game.anim[i]);
    const r = c * 0.3;
    ctx.fillStyle = COLORS.sourceBg;
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = COLORS.water;
    ctx.lineWidth = Math.max(1.5, c * 0.045);
    ctx.stroke();
    // Drop: pointed top, round bottom. It pulses gently.
    const pulse = REDUCED ? 1 : 1 + 0.07 * Math.sin(T * 3.2);
    const d = r * 0.62 * pulse;
    // The pointed top is visually light, so the drop sits a little above centre.
    ctx.translate(0, -d * 0.16);
    ctx.fillStyle = COLORS.sourceDrop;
    ctx.beginPath();
    ctx.moveTo(0, -d * 1.15);
    ctx.bezierCurveTo(d * 0.25, -d * 0.6, d * 0.85, -d * 0.05, d * 0.85, d * 0.4);
    ctx.arc(0, d * 0.4, d * 0.85, 0, Math.PI);
    ctx.bezierCurveTo(-d * 0.85, -d * 0.05, -d * 0.25, -d * 0.6, 0, -d * 1.15);
    ctx.closePath();
    ctx.fill();
    // Highlight.
    ctx.fillStyle = 'rgba(255,255,255,0.75)';
    ctx.beginPath();
    ctx.ellipse(-d * 0.32, d * 0.3, d * 0.14, d * 0.26, 0.5, 0, Math.PI * 2);
    ctx.fill();
  } else if (degree(mask) === 1) {
    // Dead end = a house that needs water. Houses stay upright while the pipe spins
    // and jump when the water arrives.
    ctx.rotate(-game.anim[i]);
    const s = c * 0.2 * (1 + 0.45 * Math.sin(Math.PI * game.pop[i]));
    ctx.fillStyle = full ? COLORS.houseWet : COLORS.houseDry;
    ctx.beginPath();
    ctx.moveTo(-s, -s * 0.1);
    ctx.lineTo(0, -s * 1.05);
    ctx.lineTo(s, -s * 0.1);
    ctx.lineTo(s * 0.78, -s * 0.1);
    ctx.lineTo(s * 0.78, s * 0.85);
    ctx.lineTo(-s * 0.78, s * 0.85);
    ctx.lineTo(-s * 0.78, -s * 0.1);
    ctx.closePath();
    ctx.fill();
    // Window: lights up once the house has water.
    ctx.fillStyle = full ? COLORS.windowLit : 'rgba(15,27,45,0.45)';
    ctx.fillRect(-s * 0.24, s * 0.1, s * 0.48, s * 0.44);
  }
  ctx.restore();
}

function draw() {
  ctx.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);
  ctx.clearRect(0, 0, view.cw, view.ch);
  if (!game || view.cell < 4) return;
  const c = view.cell;
  for (let i = 0; i < game.w * game.h; i++) drawTile(i, now);

  for (const r of game.rings) {
    const k = r.age / r.life;
    ctx.globalAlpha = (1 - k) * 0.55;
    ctx.strokeStyle = r.color;
    ctx.lineWidth = Math.max(1.5, c * 0.04) * (1 - k * 0.5);
    ctx.beginPath();
    ctx.arc(tileX(r.i), tileY(r.i), c * r.size * (0.35 + 0.65 * easeOut(k)), 0, Math.PI * 2);
    ctx.stroke();
  }
  for (const p of game.fx) {
    ctx.globalAlpha = 1 - (p.age / p.life) ** 2;
    ctx.fillStyle = p.color;
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}

let last = performance.now();
function frame(t) {
  // Schedule first: one bad frame must never stop the loop (that froze the board before).
  requestAnimationFrame(frame);
  const dt = Math.min(0.05, (t - last) / 1000);
  last = t;
  now = t / 1000;
  if (game) {
    try {
      step(dt);
    } catch (err) {
      console.error(err);
    }
    dirty = true; // water keeps moving, so the board is redrawn every frame
  }
  if (dirty) {
    dirty = false;
    try {
      draw();
    } catch (err) {
      console.error(err);
    }
  }
}

// ---------- input ----------

canvas.addEventListener('pointerdown', (e) => {
  if (!game) return;
  e.preventDefault();
  const r = canvas.getBoundingClientRect();
  const cx = Math.floor((e.clientX - r.left - view.ox) / view.cell);
  const cy = Math.floor((e.clientY - r.top - view.oy) / view.cell);
  if (cx < 0 || cy < 0 || cx >= game.w || cy >= game.h) return;
  rotate(cy * game.w + cx, e.button === 2 ? -1 : 1);
});
canvas.addEventListener('contextmenu', (e) => e.preventDefault());
window.addEventListener('resize', layout);
// The canvas can change size without a window resize (overlays, portal iframes, pane toggles).
if ('ResizeObserver' in window) new ResizeObserver(() => layout()).observe(canvas);

$('btn-menu').onclick = openMenu;
$('btn-restart').onclick = () => {
  if (!game || game.solved) return;
  if (!REDUCED) $('btn-restart').animate([{ transform: 'rotate(0)' }, { transform: 'rotate(360deg)' }], { duration: 450, easing: 'cubic-bezier(0.22,1,0.36,1)' });
  startLevel();
};
$('btn-hint').onclick = hint;
$('btn-continue').onclick = continueRun;
$('btn-new').onclick = askNewGame;
$('btn-confirm-yes').onclick = askNameThenStart;
$('btn-confirm-no').onclick = () => hide('confirm');
$('btn-leaders').onclick = openLeaders;
$('btn-leaders-close').onclick = () => hide('leaders');
$('btn-name').onclick = () => openName();
$('btn-howto').onclick = openHowTo;
$('btn-howto-ok').onclick = closeHowTo;
$('btn-name-save').onclick = saveName;
$('btn-name-skip').onclick = () => closeName(false);
$('name-input').addEventListener('keydown', (e) => e.key === 'Enter' && saveName());
$('btn-next').onclick = nextLevel;
$('btn-win-menu').onclick = openMenu;
$('btn-sound').onclick = () => {
  save.muted = !save.muted;
  persist();
  $('btn-sound').textContent = `Sound: ${progressSound()}`;
};

// Debug helpers for testing: open with ?debug
if (new URLSearchParams(location.search).has('debug')) {
  window.__drip = {
    get game() { return game; },
    get save() { return save; },
    /** Put every tile right except one, which needs a single clockwise tap. Returns its index. */
    almostSolve() {
      game.tiles.forEach((_, i) => { game.tiles[i] = game.sol[i]; });
      const i = game.tiles.findIndex((m, idx) => idx !== game.src && rotCW(m) !== m);
      game.tiles[i] = rotCCW(game.tiles[i]);
      afterChange();
      return i;
    },
    tapsTo(i) { rotate(i, 1); },
    checkHousesDone,
    jumpTo(level) { save.run.level = level; save.run.seed = newSeed(); persist(); startLevel(); },
    boardSize,
    generate,
    flood,
    isSolved,
    /** Scripted state for screenshots: ?debug&demo=<level>,<score>,<wrong tiles | win> */
    demo(level, score, mode) {
      save.tutorialSeen = true;
      newRun({ anonymous: true });
      save.run.score = score;
      this.jumpTo(level);
      const last = this.almostSolve();
      if (mode === 'win') {
        rotate(last, 1);
        return this.settle();
      }
      const n = game.w * game.h;
      for (let k = 1, done = 0; done < mode && k < n; k++) {
        const i = (k * 7) % n;
        if (i === game.src || i === last || rotCW(game.tiles[i]) === game.tiles[i]) continue;
        rotate(i, 1);
        done++;
      }
      this.settle();
    },
    /** Jump every animation to its end, so a screenshot shows a finished frame. */
    settle() {
      still = true;
      document.documentElement.classList.add('still');
      game.t0 -= 10;
      if (game.winAt !== null) game.winAt -= 10;
      for (let k = 0; k < 240; k++) step(0.05);
    },
  };
}

// ---------- boot ----------

(async function boot() {
  await Platform.init({
    mute: () => { adPlaying = true; },
    unmute: () => { adPlaying = false; },
  });
  layout();
  openMenu();
  requestAnimationFrame(frame);
  const demo = new URLSearchParams(location.search).get('demo');
  if (demo && window.__drip) {
    const [level, score, mode] = demo.split(',');
    window.__drip.demo(Number(level), Number(score), mode === 'win' ? 'win' : Number(mode));
  }
})();
