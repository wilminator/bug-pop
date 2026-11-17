// The title page's ad space.
//
// This open-source game contains no ad code at all. A deployment that wants ads (the
// official site, built by the private bug-pop-server repo) adds this to its config.json:
//
//   "ads": { "script": "ads/ads.js" }
//
// That script is the deployment's own. When it loads it must set
//
//   window.bugPopAds = { show(slot, { personalized }) { ... }, hide?(slot) { ... } }
//
// and draw at most one fixed-size ad inside `slot`. It must not add ads anywhere else
// (no anchor, pop-up or "auto" ads), because ads never appear during play.
// `personalized` is false when the player's account asks for non-personalized ads only,
// and null when the site's consent banner decides.

export type AdsConfig = { preview?: boolean; script?: string };

export type AdProvider = {
  show(slot: HTMLElement, opts: { personalized: boolean | null }): void;
  hide?(slot: HTMLElement): void;
};

declare global {
  interface Window { bugPopAds?: AdProvider }
}

let loading: Promise<AdProvider | null> | null = null;

/** Loads the deployment's ad script once. Never throws; null if it can't be had. */
export function loadAdProvider(src: string): Promise<AdProvider | null> {
  loading ??= new Promise((resolve) => {
    const s = document.createElement('script');
    s.src = src;
    s.async = true;
    s.onload = () => resolve(window.bugPopAds ?? null);
    s.onerror = () => resolve(null);
    document.head.appendChild(s);
  });
  return loading;
}

/**
 * Show or clear the ad space.
 * - preview: an outlined, empty box, so a staging site can check the layout.
 * - script: the deployment's real ads.
 * Neither: the space stays hidden and takes no room.
 */
export async function setAdSlot(slot: HTMLElement, cfg: AdsConfig | undefined, show: boolean, personalized: boolean | null) {
  slot.classList.toggle('preview', !!cfg?.preview && !cfg.script);
  if (!show || !cfg || (!cfg.preview && !cfg.script)) {
    if (cfg?.script && !slot.hidden) (await loadAdProvider(cfg.script))?.hide?.(slot);
    slot.hidden = true;
    return;
  }
  slot.hidden = false;
  if (!cfg.script) return; // preview only
  const provider = await loadAdProvider(cfg.script);
  if (provider) provider.show(slot, { personalized });
  else slot.hidden = true; // blocked by an ad blocker, or failed: leave no empty hole
}
