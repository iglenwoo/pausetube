// OffTube — Debug Console
// Live raw + derived state, with controls to force states and a raw-JSON editor.

const $ = (id) => document.getElementById(id);
const send = (msg) => chrome.runtime.sendMessage(msg);

let paused = false;
let firstLoad = true;
// Latest snapshot, kept so control handlers can read current values synchronously.
let last = { session: {}, snooze: {}, settings: {} };

// --- Formatting ---

function fmtClock(ms) {
  if (ms == null || Number.isNaN(ms)) return "—";
  const neg = ms < 0;
  const s = Math.floor(Math.abs(ms) / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  const core = h > 0
    ? `${h}:${String(m).padStart(2, "0")}:${String(ss).padStart(2, "0")}`
    : `${m}:${String(ss).padStart(2, "0")}`;
  return (neg ? "-" : "") + core;
}

function fmtAgo(ts) {
  if (!ts) return "—";
  const d = Date.now() - ts;
  if (d < 0) return "in " + fmtClock(-d);
  const s = Math.floor(d / 1000);
  if (s < 60) return s + "s ago";
  const m = Math.floor(s / 60);
  if (m < 60) return m + "m ago";
  return Math.floor(m / 60) + "h " + (m % 60) + "m ago";
}

function fmtTime(ts) {
  return ts ? new Date(ts).toLocaleTimeString() : "—";
}

function esc(v) {
  return String(v).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
}

// Mirrors content.js getElapsedMs so the displayed elapsed matches what the UI uses.
function getElapsedMs(session) {
  const base = session.elapsedMs || 0;
  if (!session.timerStartedAt) return base;
  const now = Date.now();
  const cap = session.lastActivity ? Math.min(now, session.lastActivity) : now;
  return base + Math.max(0, cap - session.timerStartedAt);
}

// Mirrors content.js getRiskLevel, but also returns the reason for display.
function computeRisk(state) {
  const { session, snooze, settings } = state;
  if (!session.startTime) return { level: "none", reason: "no session" };
  if (snooze.active) return { level: "snoozed", reason: "snooze active" };
  const highRiskMs = settings.highRiskMs ?? 120000;
  const streakLimit = settings.highRiskShortStreak ?? 3;
  const elapsed = getElapsedMs(session);
  const streak = session.shortStreak || 0;
  if (elapsed >= highRiskMs) return { level: "high", reason: `elapsed ${fmtClock(elapsed)} ≥ ${fmtClock(highRiskMs)}` };
  if (streak >= streakLimit) return { level: "high", reason: `shortStreak ${streak} ≥ ${streakLimit}` };
  return { level: "none", reason: "below thresholds" };
}

// --- Rendering ---

function rows(pairs) {
  return pairs
    .map(([k, v, cls]) => `<div class="k">${esc(k)}</div><div class="v ${cls || ""}">${v}</div>`)
    .join("");
}

async function read() {
  const state = await send({ type: "get-state" });
  const [alarms, ytTabs] = await Promise.all([
    chrome.alarms.getAll(),
    chrome.tabs.query({ url: "https://www.youtube.com/*" }),
  ]);
  return {
    session: state?.session || {},
    snooze: state?.snooze || {},
    settings: state?.settings || {},
    alarms,
    ytTabCount: ytTabs.length,
  };
}

function render(snap) {
  last = { session: snap.session, snooze: snap.snooze, settings: snap.settings };
  const { session, snooze, settings, alarms, ytTabCount } = snap;
  const now = Date.now();
  const risk = computeRisk(snap);
  const elapsed = getElapsedMs(session);
  const highRiskMs = settings.highRiskMs ?? 120000;
  const streakLimit = settings.highRiskShortStreak ?? 3;

  const toHigh = (!session.startTime || snooze.active || risk.level === "high")
    ? "—"
    : fmtClock(Math.max(0, highRiskMs - elapsed));
  const shortsToHigh = Math.max(0, streakLimit - (session.shortStreak || 0));
  const snoozeRem = snooze.active && snooze.expiresAt ? fmtClock(Math.max(0, snooze.expiresAt - now)) : "—";
  const vidsLeft = snooze.active && snooze.videoLimit
    ? Math.max(0, snooze.videoLimit - ((session.videoCount || 0) - (snooze.videosAtSnoozeStart || 0)))
    : "—";
  const timeoutIn = session.lastActivity
    ? fmtClock(Math.max(0, (settings.sessionTimeoutMin || 30) * 60000 - (now - session.lastActivity)))
    : "—";
  const alarmStr = alarms.length
    ? alarms.map((a) => `${esc(a.name)} in ${fmtClock(a.scheduledTime - now)}`).join(" · ")
    : "none";

  $("derived").innerHTML = rows([
    ["risk", `<b>${risk.level.toUpperCase()}</b> <span class="dim">(${esc(risk.reason)})</span>`, "risk-" + risk.level],
    ["time to high risk", toHigh],
    ["shorts to high", `${shortsToHigh} of ${streakLimit}`],
    ["snooze remaining", snoozeRem],
    ["videos left in snooze", vidsLeft],
    ["session timeout in", timeoutIn],
    ["open YT tabs", ytTabCount],
    ["alarms", alarmStr],
  ]);

  const watched = session.videosWatched || [];
  $("session").innerHTML = rows([
    ["startTime", session.startTime ? `${fmtTime(session.startTime)} <span class="dim">(${fmtAgo(session.startTime)})</span>` : "—"],
    ["elapsed (live)", `<b>${fmtClock(elapsed)}</b> <span class="dim">· base ${session.elapsedMs || 0}ms</span>`],
    ["timer", session.timerStartedAt
      ? `<span class="ok">● RUNNING</span> <span class="dim">since ${fmtTime(session.timerStartedAt)}</span>`
      : `<span class="dim">○ PAUSED</span>`],
    ["videoCount", session.videoCount || 0],
    ["videosWatched", watched.length ? `${watched.length}: <span class="dim">${esc(watched.join(", "))}</span>` : "0"],
    ["intent", session.intent != null ? `"${esc(session.intent)}"` : "—"],
    ["lastActivity", session.lastActivity ? `${fmtTime(session.lastActivity)} <span class="dim">(${fmtAgo(session.lastActivity)})</span>` : "—"],
    ["shortStreak", session.shortStreak || 0],
    ["snoozeCount", session.snoozeCount || 0],
    ["totalSnoozed", fmtClock(session.totalSnoozedMs || 0)],
  ]);

  $("snooze").innerHTML = rows([
    ["active", snooze.active ? `<span class="ok">true</span>` : "false"],
    ["startedAt", snooze.startedAt ? `${fmtTime(snooze.startedAt)} <span class="dim">(${fmtAgo(snooze.startedAt)})</span>` : "—"],
    ["expiresAt", snooze.expiresAt ? `${fmtTime(snooze.expiresAt)} <span class="dim">(${fmtClock(snooze.expiresAt - now)} left)</span>` : "—"],
    ["videoLimit", snooze.videoLimit ?? "—"],
    ["videosAtSnoozeStart", snooze.videosAtSnoozeStart ?? 0],
  ]);

  $("settings").innerHTML = rows(Object.keys(settings).map((k) => [k, esc(settings[k])]));
}

async function tick() {
  if (paused) return;
  try {
    const snap = await read();
    render(snap);
    if (firstLoad) { loadRaw(); firstLoad = false; }
    $("tick-status").textContent = "live · " + new Date().toLocaleTimeString();
  } catch (e) {
    $("tick-status").textContent = "error: " + e.message;
  }
}

// --- Raw editor ---

function loadRaw() {
  $("raw").value = JSON.stringify(
    { session: last.session, snooze: last.snooze, settings: last.settings },
    null,
    2
  );
}

// --- Controls ---

function flash(el, msg, ok = true) {
  el.textContent = msg;
  el.className = "ctl-status " + (ok ? "ok" : "err");
  setTimeout(() => { if (el.textContent === msg) el.textContent = ""; }, 2500);
}

async function handleAct(act, el) {
  const status = $("ctl-status");
  const now = Date.now();
  const s = last.session;
  try {
    switch (act) {
      case "jump-risk":
        if (last.snooze.active) await send({ type: "end-snooze" });
        await send({ type: "debug-apply", session: {
          startTime: s.startTime || now, timerStartedAt: now,
          elapsedMs: last.settings.highRiskMs ?? 120000, lastActivity: now,
        } });
        break;
      case "add":
        await send({ type: "debug-apply", session: {
          startTime: s.startTime || now,
          elapsedMs: getElapsedMs(s) + Number(el.dataset.ms),
          timerStartedAt: now, lastActivity: now,
        } });
        break;
      case "reset-elapsed":
        await send({ type: "debug-apply", session: { elapsedMs: 0, timerStartedAt: now } });
        break;
      case "set-elapsed":
        await send({ type: "debug-apply", session: {
          startTime: s.startTime || now,
          elapsedMs: Number($("set-elapsed").value) * 1000,
          timerStartedAt: now, lastActivity: now,
        } });
        break;
      case "add-video":
        await send({ type: "debug-apply", session: { videoCount: (s.videoCount || 0) + 1, lastActivity: now } });
        break;
      case "set-streak":
        await send({ type: "debug-apply", session: { shortStreak: Number($("set-streak").value) } });
        break;
      case "snooze":
        await send({ type: "start-snooze", minutes: Number(el.dataset.min), videoLimit: null });
        break;
      case "end-snooze":
        await send({ type: "end-snooze" });
        break;
      case "set-intent":
        await send({ type: "debug-apply", session: { intent: $("set-intent").value } });
        break;
      case "clear-intent":
        await send({ type: "debug-apply", session: { intent: null } });
        break;
      case "just-browsing":
        await send({ type: "debug-apply", session: { intent: "Just browsing" } });
        break;
      case "set-highrisk":
        await send({ type: "debug-apply", settings: { highRiskMs: Number($("set-highrisk").value) * 1000 } });
        break;
      case "set-streak-thresh":
        await send({ type: "debug-apply", settings: { highRiskShortStreak: Number($("set-streak-thresh").value) } });
        break;
      case "set-timeout":
        await send({ type: "debug-apply", settings: { sessionTimeoutMin: Number($("set-timeout").value) } });
        break;
      case "reset-session":
        await send({ type: "reset-session" });
        break;
      case "age-activity":
        await send({ type: "debug-apply", session: {
          lastActivity: now - ((last.settings.sessionTimeoutMin || 30) * 60000 + 60000),
        } });
        break;
      case "raw-load":
        loadRaw();
        flash($("raw-status"), "loaded");
        return;
      case "raw-apply": {
        let parsed;
        try {
          parsed = JSON.parse($("raw").value);
        } catch (e) {
          flash($("raw-status"), "invalid JSON: " + e.message, false);
          return;
        }
        const out = {};
        if (parsed.session) out.session = parsed.session;
        if (parsed.snooze) out.snooze = parsed.snooze;
        if (parsed.settings) out.settings = parsed.settings;
        await chrome.storage.local.set(out);
        await send({ type: "debug-refresh" });
        flash($("raw-status"), "applied");
        return;
      }
      case "raw-copy":
        await navigator.clipboard.writeText($("raw").value);
        flash($("raw-status"), "copied");
        return;
    }
    flash(status, "✓ " + act);
    tick();
  } catch (e) {
    flash(status, "✗ " + act + ": " + e.message, false);
  }
}

document.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-act]");
  if (btn) handleAct(btn.dataset.act, btn);
});

$("pause-btn").addEventListener("click", () => {
  paused = !paused;
  $("pause-btn").textContent = paused ? "▶ Resume" : "⏸ Pause";
  $("tick-status").textContent = paused ? "paused" : "live";
  if (!paused) tick();
});

$("copy-json-btn").addEventListener("click", async () => {
  await navigator.clipboard.writeText(
    JSON.stringify({ session: last.session, snooze: last.snooze, settings: last.settings }, null, 2)
  );
  $("copy-json-btn").textContent = "Copied!";
  setTimeout(() => { $("copy-json-btn").textContent = "Copy JSON"; }, 1500);
});

tick();
setInterval(tick, 500);
