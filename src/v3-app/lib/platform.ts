// Which modifier key to NAME in the UI.
//
// The shortcut handlers already accept both: app.tsx opens the palette on
// `(e.metaKey || e.ctrlKey) && k`, and ReviewPane confirms-all on
// `(e.metaKey || e.ctrlKey) && enter`. So Ctrl+K has always WORKED on Windows —
// the only thing that was wrong is that every label said "⌘K", which reads as
// "this app is not for you" to the majority of Anvil operators, who are on
// Windows.
//
// Detection order matters. navigator.platform is deprecated and frozen in some
// browsers, so userAgentData.platform is preferred where present; both are
// wrapped because neither exists in a non-browser or jsdom-without-navigator
// context, and a throw here would take the whole header down.

const APPLE_RE = /^(mac|iphone|ipad|ipod)/i;

export const isApplePlatform = (): boolean => {
  if (typeof navigator === "undefined") return false;
  try {
    const uaPlatform = (navigator as any)?.userAgentData?.platform;
    if (typeof uaPlatform === "string" && uaPlatform) return APPLE_RE.test(uaPlatform);
    // iPadOS 13+ reports "MacIntel" here and is Apple either way, so the same
    // test is correct for it.
    const legacy = (navigator as any)?.platform;
    if (typeof legacy === "string" && legacy) return APPLE_RE.test(legacy);
    const ua = navigator.userAgent;
    if (typeof ua === "string") return /\b(Macintosh|Mac OS X|iPhone|iPad|iPod)\b/.test(ua);
  } catch {
    /* fall through to the non-Apple default */
  }
  return false;
};

// Anything unknown falls back to "Ctrl", which is the right bet for Anvil's
// user base and is also the more legible of the two when wrong.
export const modKeyLabel = (): string => (isApplePlatform() ? "⌘" : "Ctrl");

// Display label for a mod-key chord, e.g. "⌘K" / "Ctrl K".
//
// The Mac convention is no separator ("⌘K"); the Windows convention is a
// separator ("Ctrl+K"). A thin space rather than "+" keeps the <kbd> narrow
// enough for the header without looking like two separate keys.
export const shortcutLabel = (key: string): string => {
  const k = String(key || "").toUpperCase();
  return isApplePlatform() ? "⌘" + k : "Ctrl " + k;
};

// Spoken form for aria-label / title, where the glyph is unhelpful: a screen
// reader says "place of interest sign" for ⌘.
export const shortcutAria = (key: string): string =>
  (isApplePlatform() ? "Command+" : "Ctrl+") + String(key || "").toUpperCase();
