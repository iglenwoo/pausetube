// PauseTube — Shared config
// Single source of truth for what is configurable, the valid range, and the
// defaults. Loaded by the service worker (importScripts), the content script
// (manifest content_scripts), and the popup/options/debug pages (<script>).
//
// Settings are stored *sparsely* in chrome.storage.local.settings: only the
// keys the user has actually changed are persisted. The effective settings the
// rest of the app reads are DEFAULT_SETTINGS with those overrides applied on
// top (see effectiveSettings). Keeping overrides sparse means a future change
// to a default automatically reaches anyone who hasn't overridden that key.

(function (root) {
  "use strict";

  // Each entry drives three things at once: the default value, the Options-page
  // control, and the clamp applied on every write. Add a knob here and it shows
  // up in the Options UI and gets validated automatically.
  //
  // Number knobs are stored in their canonical unit (e.g. highRiskMs in ms) and
  // shown in the UI divided by `scale` (so a 180000 ms default reads as "3 min").
  const SETTINGS_SCHEMA = [
    {
      key: "highRiskMs",
      group: "The gate",
      label: "Browse time before the gate",
      help: "How long you can browse before the breathing gate interrupts.",
      type: "number", unit: "min", scale: 60000,
      default: 3 * 60 * 1000, min: 30 * 1000, max: 30 * 60 * 1000, step: 30 * 1000,
    },
    {
      key: "sessionTimeoutMin",
      group: "The gate",
      label: "Reset the session after inactivity",
      help: "Time away from YouTube before your next visit starts a fresh session (new intent prompt).",
      type: "number", unit: "min", scale: 1,
      default: 30, min: 1, max: 240, step: 1,
    },
    {
      key: "breatheInhaleSec",
      group: "Breathing",
      label: "Inhale",
      help: "Length of the inhale beat on the breathing gate.",
      type: "number", unit: "sec", scale: 1,
      default: 4, min: 1, max: 10, step: 1,
    },
    {
      key: "breatheExhaleSec",
      group: "Breathing",
      label: "Exhale",
      help: "Length of the exhale beat on the breathing gate.",
      type: "number", unit: "sec", scale: 1,
      default: 4, min: 1, max: 10, step: 1,
    },
    {
      key: "popupSnoozeOptions",
      group: "Snooze",
      label: "Popup snooze buttons",
      help: "Minute options offered in the toolbar popup.",
      type: "minutes-list", default: [1, 5, 10],
    },
    {
      key: "gateSnoozeOptions",
      group: "Snooze",
      label: "Gate snooze buttons",
      help: "“More minutes” options offered on the breathing gate.",
      type: "minutes-list", default: [1, 3],
    },
    {
      key: "intentPromptEnabled",
      group: "Intent",
      label: "Ask what you’re here to watch",
      help: "Show the intent prompt on the first video of a session.",
      type: "bool", default: true,
    },
    {
      key: "promptOnDirectLinks",
      group: "Intent",
      label: "Also ask on links opened from outside YouTube",
      help: "By default, videos opened from a shared link skip the intent prompt.",
      type: "bool", default: false,
    },
  ];

  const SCHEMA_BY_KEY = Object.fromEntries(SETTINGS_SCHEMA.map((s) => [s.key, s]));

  function clone(v) {
    return Array.isArray(v) ? v.slice() : v;
  }

  const DEFAULT_SETTINGS = Object.fromEntries(
    SETTINGS_SCHEMA.map((s) => [s.key, clone(s.default)])
  );

  function clampNumber(spec, v) {
    const n = Number(v);
    if (!Number.isFinite(n)) return undefined;
    return Math.min(spec.max, Math.max(spec.min, n));
  }

  function clampMinutesList(v) {
    if (!Array.isArray(v)) return undefined;
    const cleaned = [
      ...new Set(
        v
          .map((x) => Math.round(Number(x)))
          .filter((n) => Number.isFinite(n) && n >= 1 && n <= 180)
      ),
    ].sort((a, b) => a - b);
    return cleaned.length ? cleaned : undefined;
  }

  // Validate/normalise a (possibly partial) settings object. Unknown keys are
  // dropped; out-of-range numbers are clamped; un-coercible values are removed
  // so the default can fill in.
  function clampSettings(input) {
    const out = {};
    if (!input || typeof input !== "object") return out;
    for (const spec of SETTINGS_SCHEMA) {
      if (!(spec.key in input)) continue;
      const raw = input[spec.key];
      let v;
      if (spec.type === "number") v = clampNumber(spec, raw);
      else if (spec.type === "bool") v = Boolean(raw);
      else if (spec.type === "minutes-list") v = clampMinutesList(raw);
      if (v !== undefined) out[spec.key] = v;
    }
    return out;
  }

  // Full, valid settings: defaults with any (valid) overrides applied on top.
  function effectiveSettings(overrides) {
    return { ...DEFAULT_SETTINGS, ...clampSettings(overrides) };
  }

  function equalsDefault(key, value) {
    const def = DEFAULT_SETTINGS[key];
    if (Array.isArray(def)) return JSON.stringify(def) === JSON.stringify(value);
    return def === value;
  }

  // Strip keys equal to their default so stored overrides stay sparse.
  function toSparse(full) {
    const out = {};
    if (!full || typeof full !== "object") return out;
    for (const spec of SETTINGS_SCHEMA) {
      if (spec.key in full && !equalsDefault(spec.key, full[spec.key])) {
        out[spec.key] = full[spec.key];
      }
    }
    return out;
  }

  // In-page timer pill. Every number counts toward something: blue = minutes left before the gate, yellow =
  // minutes left in a snooze (borrowed time), red = minutes past the gate.
  const BADGE_COLORS = {
    ok: { background: "#3B82F6", text: "#FFFFFF" },
    snoozed: { background: "#F59E0B", text: "#1F2937" },
    over: { background: "#991B1B", text: "#FFFFFF" },
  };

  function badgeState({ elapsedMs, highRiskMs, snooze, now = Date.now() }) {
    if (snooze?.active) {
      if (!snooze.expiresAt) return { kind: "snoozed", minutes: null };
      return {
        kind: "snoozed",
        minutes: Math.ceil(Math.max(0, snooze.expiresAt - now) / 60000),
      };
    }
    if (elapsedMs < highRiskMs) {
      return { kind: "ok", minutes: Math.ceil((highRiskMs - elapsedMs) / 60000) };
    }
    return { kind: "over", minutes: Math.floor((elapsedMs - highRiskMs) / 60000) };
  }

  // Toolbar badge: snoozes this session. The color blends from calm blue at 1
  // through violet and crimson to red-black at 10+, getting more serious with
  // each snooze. The top is near-black so it stays distinct on the red icon.
  const SNOOZE_BADGE_STOPS = [
    { count: 1, color: [0x3b, 0x82, 0xf6] }, // blue
    { count: 4, color: [0x7c, 0x3a, 0xed] }, // violet
    { count: 7, color: [0xbe, 0x12, 0x3c] }, // crimson
    { count: 10, color: [0x45, 0x0a, 0x0a] }, // red-black
  ];

  const toHex = (rgb) => "#" + rgb.map((c) => c.toString(16).padStart(2, "0")).join("");

  function snoozeBadgeColors(count) {
    const stops = SNOOZE_BADGE_STOPS;
    const n = Math.min(Math.max(count, stops[0].count), stops[stops.length - 1].count);
    let i = 0;
    while (n > stops[i + 1]?.count) i++;
    const lo = stops[i];
    const hi = stops[i + 1] || lo;
    const t = hi === lo ? 0 : (n - lo.count) / (hi.count - lo.count);
    const rgb = lo.color.map((c, k) => Math.round(c + (hi.color[k] - c) * t));
    // Every color on the ramp is dark enough for white text.
    return { background: toHex(rgb), text: "#FFFFFF" };
  }

  root.PauseTubeConfig = {
    SETTINGS_SCHEMA,
    SCHEMA_BY_KEY,
    DEFAULT_SETTINGS,
    clampSettings,
    effectiveSettings,
    toSparse,
    BADGE_COLORS,
    badgeState,
    snoozeBadgeColors,
  };
})(typeof self !== "undefined" ? self : this);
