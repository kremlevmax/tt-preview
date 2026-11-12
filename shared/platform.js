// Platform layer: one game build, many destinations.
//
// Games never talk to an ad SDK directly. They call Platform.* and this file
// maps the calls onto whichever portal/store the build is running on.
//
// Pick the adapter with ?platform=poki|crazygames|none, or set
// window.PLATFORM before this module loads (store-specific builds do that).
//   none        - local development: shows placeholder "ads"
//   off         - no ads at all (fallback when an SDK fails to load, e.g. adblock)
//   poki        - Poki SDK v2
//   crazygames  - CrazyGames SDK v3
// Before submitting to a portal, re-check its SDK docs: APIs and URLs change.

const params = new URLSearchParams(location.search);
const requested = String(window.PLATFORM || params.get('platform') || 'none').toLowerCase();

// Portals that decide ad frequency themselves: the game offers every natural break
// and must not run its own ad timers.
const MANAGED = requested === 'poki' || requested === 'crazygames';

let audio = { mute() {}, unmute() {} };

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const el = document.createElement('script');
    el.src = src;
    el.onload = resolve;
    el.onerror = () => reject(new Error(`Failed to load ${src}`));
    document.head.appendChild(el);
  });
}

/** Development stand-in for a real ad: full screen, with a countdown, so it can't be missed. */
function placeholderAd(label, seconds) {
  return new Promise((resolve) => {
    const el = document.createElement('div');
    el.style.cssText =
      'position:fixed;inset:0;z-index:9999;display:flex;flex-direction:column;gap:12px;align-items:center;' +
      'justify-content:center;text-align:center;padding:24px;background:#000e;color:#fff;font:600 20px system-ui,sans-serif;';
    const title = document.createElement('div');
    title.textContent = `📺 ${label}`;
    const count = document.createElement('div');
    count.style.cssText = 'font-size:44px;color:#ffc94d';
    const note = document.createElement('div');
    note.style.cssText = 'font-size:13px;font-weight:400;color:#aab';
    note.textContent = 'Placeholder. Real ads appear when the game runs on a portal.';
    el.append(title, count, note);
    document.body.appendChild(el);
    audio.mute();
    let left = seconds;
    count.textContent = left;
    const timer = setInterval(() => {
      left -= 1;
      count.textContent = left;
      if (left > 0) return;
      clearInterval(timer);
      el.remove();
      audio.unmute();
      resolve();
    }, 1000);
  });
}

function crazyAd(type) {
  return new Promise((resolve) => {
    window.CrazyGames.SDK.ad.requestAd(type, {
      adStarted: () => audio.mute(),
      adFinished: () => { audio.unmute(); resolve(true); },
      adError: () => { audio.unmute(); resolve(false); },
    });
  });
}

const adapters = {
  none: {
    async init() {},
    gameplayStart() {},
    gameplayStop() {},
    async interstitial() { await placeholderAd('Ad break', 3); },
    async rewarded() { await placeholderAd('Rewarded ad: hint unlocks after this', 3); return true; },
  },
  off: {
    async init() {},
    gameplayStart() {},
    gameplayStop() {},
    async interstitial() {},
    // No ad could be shown, so grant the reward rather than punish the player.
    async rewarded() { return true; },
  },
  // A portal build whose SDK could not load (ad blocker): no ads and, by portal rules, no rewards.
  blocked: {
    async init() {},
    gameplayStart() {},
    gameplayStop() {},
    async interstitial() {},
    async rewarded() { return false; },
  },
  poki: {
    async init() {
      await loadScript('https://game-cdn.poki.com/scripts/v2/poki-sdk.js');
      await window.PokiSDK.init();
      window.PokiSDK.gameLoadingFinished?.();
    },
    measure(category, what, action) { window.PokiSDK.measure?.(category, what, action); },
    language() { return window.PokiSDK.getLanguage?.(); },
    gameplayStart() { window.PokiSDK.gameplayStart(); },
    gameplayStop() { window.PokiSDK.gameplayStop(); },
    async interstitial() {
      await window.PokiSDK.commercialBreak(() => audio.mute());
      audio.unmute();
    },
    async rewarded() {
      const ok = await window.PokiSDK.rewardedBreak(() => audio.mute());
      audio.unmute();
      return !!ok;
    },
  },
  crazygames: {
    async init() {
      await loadScript('https://sdk.crazygames.com/crazygames-sdk-v3.js');
      await window.CrazyGames.SDK.init();
    },
    gameplayStart() { window.CrazyGames.SDK.game.gameplayStart(); },
    gameplayStop() { window.CrazyGames.SDK.game.gameplayStop(); },
    async interstitial() { await crazyAd('midgame'); },
    async rewarded() { return crazyAd('rewarded'); },
  },
};

let impl = adapters[requested] || adapters.none;
let playing = false;
let inAd = false;

async function ad(fn, fallback) {
  if (inAd) return fallback;
  inAd = true;
  try {
    return await fn();
  } catch (err) {
    console.warn('[platform]', err);
    return fallback;
  } finally {
    inAd = false;
    audio.unmute();
  }
}

async function safe(fn, fallback) {
  try {
    return await fn();
  } catch (err) {
    console.warn('[platform]', err);
    return fallback;
  }
}

export const Platform = {
  get name() { return Object.keys(adapters).find((k) => adapters[k] === impl); },
  /** True when the portal paces ads itself (Poki, CrazyGames). */
  get managedAds() { return MANAGED; },
  /** True when a hint really costs an ad view. */
  get hasAds() { return impl !== adapters.off && impl !== adapters.blocked; },

  /** handlers: { mute(), unmute() } - called around ads so the game goes quiet. */
  async init(handlers = {}) {
    audio = { ...audio, ...handlers };
    try {
      await impl.init();
    } catch (err) {
      console.warn('[platform] SDK failed to start, running without ads', err);
      impl = MANAGED ? adapters.blocked : adapters.off;
    }
  },

  // Portals reject repeated events and events fired during an ad, so both are filtered here.
  gameplayStart() {
    if (playing || inAd) return;
    playing = true;
    safe(() => impl.gameplayStart());
  },

  gameplayStop() {
    if (!playing || inAd) return;
    playing = false;
    safe(() => impl.gameplayStop());
  },

  /** The player's language: the portal's choice where it has one, else the browser's. */
  get language() {
    try {
      return impl.language?.() || navigator.language || 'en';
    } catch {
      return 'en';
    }
  },

  /** Progress analytics where the portal offers them, e.g. measure('level', '3', 'start'). */
  measure(category, what, action) { safe(() => impl.measure?.(category, String(what), action)); },

  /** Ad opportunity before the player returns to the game. Always resolves. */
  interstitial() { return ad(() => impl.interstitial()); },

  /**
   * Tell the portal a rewarded-ad button is on screen, e.g. offerShown('hint').
   * Call it once each time the offer appears. Silent where there are no ads.
   */
  offerShown(placement) {
    if (this.hasAds) this.measure('rewarded', placement, 'visible');
  },

  /**
   * Ad for a reward. Resolves true when the reward should be granted.
   * Pass the same placement name as in offerShown() so the portal can compare
   * how many players saw the button with how many used it.
   */
  rewarded(placement) {
    if (inAd) return Promise.resolve(false);
    if (placement && this.hasAds) this.measure('rewarded', placement, 'interact');
    return ad(() => impl.rewarded(), false);
  },
};

/** localStorage that never throws (private mode, blocked storage, sandboxed iframes). */
export const store = {
  load(key, defaults) {
    try {
      const raw = localStorage.getItem(key);
      if (raw) return { ...structuredClone(defaults), ...JSON.parse(raw) };
    } catch {}
    return structuredClone(defaults);
  },
  save(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {}
  },
};
