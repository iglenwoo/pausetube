// PauseTube — Content Script
// Injected into YouTube pages: blur, intent prompt, floating badge

import { PauseTubeConfig as CONFIG } from "@/utils/config";
import "./style.css";

export default defineContentScript({
  matches: ["https://www.youtube.com/*"],
  runAt: "document_idle",

  main() {
    let currentState = null;
    let badgeEl = null;
    let stickyEl = null;
    let badgeInterval = null;
    let heartbeatInterval = null;
    let toastMidpointTimer = null;
    let lastKnownSessionStart = null;
    let lastDisplayedMinute = null;
    let releaseGateFocus = null;
    let releaseIntentFocus = null;

    // --- State ---

    async function fetchState() {
      try {
        currentState = await chrome.runtime.sendMessage({ type: "get-state" });
      } catch {
        currentState = null;
      }
      return currentState;
    }

    function isSnoozed() {
      return currentState?.snooze?.active === true;
    }

    // Effective settings always carry every key (background fills defaults), but
    // fall back to the shared defaults for the brief window before first fetch.
    function getSettings() {
      return { ...CONFIG.DEFAULT_SETTINGS, ...(currentState?.settings || {}) };
    }

    function getElapsedMs(session) {
      const base = session.elapsedMs || 0;
      if (!session.timerStartedAt) return base;
      const now = Date.now();
      // Cap at lastActivity so a stale timerStartedAt (from before sleep)
      // doesn't inflate the displayed elapsed time.
      const cap = session.lastActivity ? Math.min(now, session.lastActivity) : now;
      return base + Math.max(0, cap - session.timerStartedAt);
    }

    function getRiskLevel() {
      if (!currentState?.session?.startTime) return "none";
      if (isSnoozed()) return "snoozed";
      // The session hasn't really started until the user commits to an intent.
      // While the intent prompt is still on screen, don't count risk time —
      // set-intent restarts the clock once they answer.
      if (document.querySelector(".pausetube-intent-overlay")) return "none";
      const highRiskMs = getSettings().highRiskMs;
      const elapsed = getElapsedMs(currentState.session);
      if (elapsed >= highRiskMs) return "high";
      return "none";
    }

    // --- Modal Plumbing ---

    // Both overlays are modal, and the gate can in principle mount while the
    // intent prompt is still up, so the lock is reference-counted by owner —
    // whoever unmounts last releases it.
    const scrollLockOwners = new Set();
    let lockedScrollY = 0;

    function lockScroll(owner) {
      if (scrollLockOwners.has(owner)) return;
      if (scrollLockOwners.size === 0) {
        lockedScrollY = window.scrollY;
        document.documentElement.classList.add("pausetube-scroll-lock");
      }
      scrollLockOwners.add(owner);
    }

    function unlockScroll(owner) {
      if (!scrollLockOwners.delete(owner)) return;
      if (scrollLockOwners.size > 0) return;
      document.documentElement.classList.remove("pausetube-scroll-lock");
      // No-op where the browser kept the offset; insurance where it didn't.
      window.scrollTo(0, lockedScrollY);
    }

    // The gate pauses playback for as long as it's on screen, not just once at
    // mount — otherwise YouTube's autoplay (or a click that lands before the
    // overlay does) restarts the video behind it.
    let pauseGuard = null;

    function startPauseEnforcement() {
      if (!pauseGuard) {
        pauseGuard = (e) => {
          if (e.target instanceof HTMLMediaElement) e.target.pause();
        };
        // `play` doesn't bubble, so listen in the capture phase: that catches
        // every media element, including ones YouTube swaps in mid-gate.
        document.addEventListener("play", pauseGuard, true);
      }
      document.querySelectorAll("video").forEach((v) => v.pause());
    }

    function stopPauseEnforcement() {
      if (!pauseGuard) return;
      document.removeEventListener("play", pauseGuard, true);
      pauseGuard = null;
    }

    // --- Dialog Focus / Keyboard ---

    const FOCUSABLE_SELECTOR =
      'button:not([disabled]), input:not([disabled]), select, textarea, a[href], [tabindex]:not([tabindex="-1"])';

    // Rendered focusables only — the gate keeps its snooze buttons in the DOM,
    // display:none, for the whole breathing phase.
    function focusableIn(root) {
      return Array.from(root.querySelectorAll(FOCUSABLE_SELECTOR))
        .filter((el) => el.getClientRects().length > 0);
    }

    // Only the topmost dialog reacts to keys, so overlapping traps can't fight
    // each other over focus.
    const trapStack = [];

    // Keyboard contract shared by both dialogs:
    //   Tab / Shift+Tab, ArrowDown / ArrowUp   cycle the controls, never leaving
    //   Enter / Space                          activate the focused control
    //   anything else                          is swallowed
    // The listener sits on document in the capture phase because YouTube binds
    // its own shortcuts (space, j/k/l, /, arrows) at the document level too:
    // capture runs first, and stopping propagation there is what keeps the page
    // inert behind a modal. The flip side is that listeners inside the dialog
    // never see the event, so Enter on a non-button (the intent input) is routed
    // through opts.onEnter. Default actions — typing, a button's Enter/Space
    // click — are untouched by stopPropagation, so they still work.
    // Returns a teardown that also restores focus to wherever it came from.
    function trapFocus(container, opts = {}) {
      const restoreTo = document.activeElement;
      const token = {};

      function move(delta) {
        const items = focusableIn(container);
        if (!items.length) return;
        const at = items.indexOf(document.activeElement);
        const next = at === -1
          ? (delta > 0 ? 0 : items.length - 1)
          : (at + delta + items.length) % items.length;
        items[next].focus();
      }

      function isTop() {
        return trapStack[trapStack.length - 1] === token;
      }

      function onKeyDown(e) {
        if (!isTop()) return;

        if (!container.contains(e.target)) {
          // Focus escaped (or never landed) — swallow the key and pull it back.
          e.preventDefault();
          e.stopPropagation();
          focusableIn(container)[0]?.focus();
          return;
        }
        e.stopPropagation();

        if (e.key === "Tab") {
          e.preventDefault();
          move(e.shiftKey ? -1 : 1);
        } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
          // Text fields keep the arrows for caret movement.
          if (e.target.matches("input, textarea")) return;
          e.preventDefault();
          move(e.key === "ArrowDown" ? 1 : -1);
        } else if (e.key === "Enter" && !e.target.matches("button, a[href]")) {
          // Buttons activate themselves; anything else defers to the dialog.
          opts.onEnter?.(e);
        }
      }

      // keypress/keyup carry YouTube shortcuts of their own, and nothing in the
      // dialogs listens for them.
      const swallow = (e) => { if (isTop()) e.stopPropagation(); };

      trapStack.push(token);
      document.addEventListener("keydown", onKeyDown, true);
      document.addEventListener("keyup", swallow, true);
      document.addEventListener("keypress", swallow, true);

      return function release() {
        const at = trapStack.indexOf(token);
        if (at !== -1) trapStack.splice(at, 1);
        document.removeEventListener("keydown", onKeyDown, true);
        document.removeEventListener("keyup", swallow, true);
        document.removeEventListener("keypress", swallow, true);
        // Hand focus back only if the dialog still holds it.
        if (container.contains(document.activeElement) && restoreTo?.isConnected) {
          restoreTo.focus?.();
        }
      };
    }

    // --- Feed Hidden Banner ---

    async function handleSnoozeClick(minutes, videoLimit) {
      await chrome.runtime.sendMessage({ type: "start-snooze", minutes, videoLimit });
      await resumePlayback();
    }

    // Resume playback only in the tab where the snooze was chosen (the gate here,
    // or the popup's active tab). Other tabs lift their gate off the storage
    // change but stay paused. Sync state first so the gate's pause guard is gone
    // before play() — otherwise it pauses the video straight back.
    async function resumePlayback() {
      await fetchState();
      applyRiskUI();
      document.querySelectorAll("video").forEach((v) => v.play().catch(() => {}));
    }

    function runBreathing(banner, onComplete) {
      const circle = banner.querySelector(".pausetube-breathe-circle");
      const viewport = banner.querySelector(".pausetube-breathe-viewport");
      const strip = banner.querySelector(".pausetube-breathe-strip");
      const steps = banner.querySelectorAll(".pausetube-breathe-step");
      const countLabel = banner.querySelector(".pausetube-breathe-count");

      const settings = getSettings();
      const INHALE_S = settings.breatheInhaleSec;
      const EXHALE_S = settings.breatheExhaleSec;
      // The circle's grow/shrink transition is 4s in CSS; override it so the
      // animation tracks the configured inhale/exhale lengths.
      function setCircleDuration(sec) {
        circle.style.transition =
          `transform ${sec}s ease-in-out, opacity ${sec}s ease-in-out, background-color ${sec}s ease-in-out`;
      }
      const PHASES = ["ready", "inhale", "hold", "exhale"];

      function translateToStep(stepEl) {
        // Center stepEl in the viewport by translating the strip.
        const stepCenter = stepEl.offsetLeft + stepEl.offsetWidth / 2;
        const viewportCenter = viewport.clientWidth / 2;
        strip.style.transform = `translateX(${viewportCenter - stepCenter}px)`;
      }

      function setActivePhase(name) {
        const activeIdx = PHASES.indexOf(name);
        steps.forEach((step, idx) => {
          step.classList.toggle("active", idx === activeIdx);
          step.classList.toggle("past", activeIdx >= 0 && idx < activeIdx);
        });
        if (activeIdx >= 0) translateToStep(steps[activeIdx]);
      }

      // Initial position without animation (strip starts off-center otherwise).
      strip.style.transition = "none";
      setActivePhase("ready");
      // Force a frame so the initial transform lands, then re-enable transition.
      requestAnimationFrame(() => {
        strip.style.transition = "";
      });
      countLabel.textContent = "";

      setTimeout(() => {
        // t=1s: inhale
        setActivePhase("inhale");
        countLabel.textContent = INHALE_S;
        setCircleDuration(INHALE_S);
        requestAnimationFrame(() => circle.classList.add("inhaling"));

        let inhaleElapsed = 0;
        const inhaleTick = setInterval(() => {
          inhaleElapsed++;
          if (inhaleElapsed < INHALE_S) {
            countLabel.textContent = INHALE_S - inhaleElapsed;
          } else {
            clearInterval(inhaleTick);
            // t=5s: hold
            setActivePhase("hold");
            countLabel.textContent = "";

            setTimeout(() => {
              // t=6s: exhale
              setActivePhase("exhale");
              countLabel.textContent = EXHALE_S;
              setCircleDuration(EXHALE_S);
              circle.classList.remove("inhaling");

              let exhaleElapsed = 0;
              const exhaleTick = setInterval(() => {
                exhaleElapsed++;
                if (exhaleElapsed < EXHALE_S) {
                  countLabel.textContent = EXHALE_S - exhaleElapsed;
                } else {
                  clearInterval(exhaleTick);
                  // t=10s: drift past exhale so the strip glides off to the left.
                  steps.forEach((step) => {
                    step.classList.remove("active");
                    step.classList.add("past");
                  });
                  const last = steps[steps.length - 1];
                  const viewportCenter = viewport.clientWidth / 2;
                  const pastEnd = last.offsetLeft + last.offsetWidth + 40;
                  strip.style.transform = `translateX(${viewportCenter - pastEnd}px)`;
                  countLabel.textContent = "";
                  setTimeout(onComplete, 500);
                }
              }, 1000);
            }, 1000);
          }
        }, 1000);
      }, 1000);
    }

    function showSnoozePhase(banner) {
      const breatheEl = banner.querySelector(".pausetube-phase-breathe");
      const snoozeEl = banner.querySelector(".pausetube-phase-snooze");
      breatheEl.classList.add("fading");
      setTimeout(() => {
        breatheEl.style.display = "none";
        snoozeEl.style.display = "flex";
        requestAnimationFrame(() => {
          snoozeEl.classList.add("visible");
          // Nothing was focusable during the breathing phase; land on "I'm done"
          // so Enter picks the restful option.
          focusableIn(snoozeEl)[0]?.focus();
        });
      }, 300);
    }

    function showFeedHiddenBanner() {
      if (document.querySelector(".pausetube-feed-banner")) return;

      const session = currentState?.session || {};
      const elapsed = getElapsedMs(session);
      const min = Math.floor(elapsed / 60000);
      const videos = session.videoCount || 0;
      const snoozes = session.snoozeCount || 0;
      // Same color ramp as the toolbar badge; neutral until the first snooze.
      const snoozeStyle = snoozes
        ? ` style="background: ${CONFIG.snoozeBadgeColors(snoozes).background}"`
        : "";
      const snoozeOptions = getSettings().gateSnoozeOptions;

      const banner = document.createElement("div");
      banner.className = "pausetube-feed-banner";
      banner.setAttribute("role", "dialog");
      banner.setAttribute("aria-modal", "true");
      banner.setAttribute("aria-label", "PauseTube session check");
      banner.innerHTML = `
        <div class="pausetube-phase-breathe">
          <div class="pausetube-breathe-title">Deep Breath</div>
          <div class="pausetube-breathe-circle"></div>
          <div class="pausetube-breathe-text">
            <div class="pausetube-breathe-viewport">
              <div class="pausetube-breathe-strip">
                <span class="pausetube-breathe-step" data-phase="ready">ready</span>
                <span class="pausetube-breathe-arrow">→</span>
                <span class="pausetube-breathe-step" data-phase="inhale">inhale</span>
                <span class="pausetube-breathe-arrow">→</span>
                <span class="pausetube-breathe-step" data-phase="hold">hold</span>
                <span class="pausetube-breathe-arrow">→</span>
                <span class="pausetube-breathe-step" data-phase="exhale">exhale</span>
              </div>
            </div>
            <span class="pausetube-breathe-count"></span>
          </div>
        </div>
        <div class="pausetube-phase-snooze">
          <div class="pausetube-stats">
            <div class="pausetube-stat">
              <span class="pausetube-stat-num">${min}</span>
              <span class="pausetube-stat-label">min here</span>
            </div>
            <div class="pausetube-stat">
              <span class="pausetube-stat-num">${videos}</span>
              <span class="pausetube-stat-label">video${videos !== 1 ? "s" : ""}</span>
            </div>
            <div class="pausetube-stat pausetube-stat-snoozes${snoozes ? " active" : ""}"${snoozeStyle}>
              <span class="pausetube-stat-num">${snoozes}</span>
              <span class="pausetube-stat-label">snooze${snoozes !== 1 ? "s" : ""}</span>
            </div>
          </div>
          <button class="pausetube-choice-done">I'm done</button>
          <button class="pausetube-choice-cancel">Cancel session</button>
        </div>
      `;

      // Snooze ("more min") buttons are configurable — build them from settings and
      // insert them between "I'm done" and "Cancel session".
      const snoozePhase = banner.querySelector(".pausetube-phase-snooze");
      const cancelBtn = snoozePhase.querySelector(".pausetube-choice-cancel");
      snoozeOptions.forEach((minutes) => {
        const btn = document.createElement("button");
        btn.className = "pausetube-choice-snooze";
        btn.textContent = `${minutes} more min`;
        btn.addEventListener("click", () => handleSnoozeClick(minutes, null));
        snoozePhase.insertBefore(btn, cancelBtn);
      });

      banner.querySelector(".pausetube-choice-done")?.addEventListener("click", () => {
        chrome.runtime.sendMessage({ type: "done-session" });
      });

      banner.querySelector(".pausetube-choice-cancel")?.addEventListener("click", async () => {
        await chrome.runtime.sendMessage({ type: "reset-session" });
        await fetchState();
        applyRiskUI();
        removeIntentSticky();
        if (shouldShowIntent()) showIntentPrompt();
      });

      document.body.appendChild(banner);
      lockScroll("gate");
      releaseGateFocus = trapFocus(banner);
      runBreathing(banner, () => showSnoozePhase(banner));
    }

    function removeFeedHiddenBanner() {
      releaseGateFocus?.();
      releaseGateFocus = null;
      document.querySelector(".pausetube-feed-banner")?.remove();
      unlockScroll("gate");
    }

    // --- Orphan Handling ---

    // After an extension update/reload this copy is orphaned: chrome.* calls
    // fail, and the background injects a fresh copy into the tab. Stop every
    // timer and listener here so the stale copy doesn't fight the new one
    // (e.g. a failed fetchState reading as "no session" and lifting the blur).
    // DOM cleanup is left to the new copy — this one can't tell its nodes apart.
    let orphaned = false;

    function stopIfOrphaned() {
      if (orphaned) return true;
      if (chrome.runtime?.id) return false;
      orphaned = true;
      clearInterval(badgeInterval);
      clearInterval(heartbeatInterval);
      clearTimeout(toastMidpointTimer);
      urlObserver.disconnect();
      stopPauseEnforcement();
      releaseGateFocus?.();
      releaseIntentFocus?.();
      return true;
    }

    // Remove UI left behind by an orphaned copy before mounting our own.
    function removeStaleUI() {
      document
        .querySelectorAll(
          ".pausetube-feed-banner, .pausetube-intent-overlay, .pausetube-intent-sticky, " +
            ".pausetube-badge, .pausetube-toast, .pausetube-minute-pulse-backdrop, .pausetube-minute-pulse"
        )
        .forEach((el) => el.remove());
      document.documentElement.classList.remove("pausetube-blur", "pausetube-scroll-lock");
    }

    // --- Risk UI ---

    function applyRiskUI() {
      const risk = getRiskLevel();

      if (currentState?.session?.startTime !== lastKnownSessionStart) {
        lastKnownSessionStart = currentState?.session?.startTime || null;
        lastDisplayedMinute = null;
      }

      if (risk === "snoozed" || risk === "none") {
        document.documentElement.classList.remove("pausetube-blur");
        stopPauseEnforcement();
        removeFeedHiddenBanner();
        return;
      }

      // high
      document.documentElement.classList.add("pausetube-blur");
      startPauseEnforcement();
      showFeedHiddenBanner();
    }

    // --- Intent Prompt ---

    function isDirectVideoLink() {
      const url = new URL(window.location.href);
      if (url.pathname !== "/watch") return false;

      // If referrer is not youtube.com, it's likely a shared link
      try {
        if (document.referrer) {
          const ref = new URL(document.referrer);
          return ref.hostname !== "www.youtube.com";
        }
      } catch {
        // No referrer = likely direct navigation or shared link
      }
      return true;
    }

    function shouldShowIntent() {
      if (!currentState) return false;
      const settings = getSettings();
      if (!settings.intentPromptEnabled) return false;
      if (isSnoozed()) return false;
      if (currentState.session.intent) return false;
      if (!settings.promptOnDirectLinks && isDirectVideoLink()) return false;
      return true;
    }

    function showIntentPrompt() {
      if (document.querySelector(".pausetube-intent-overlay")) return;

      const overlay = document.createElement("div");
      overlay.className = "pausetube-intent-overlay";
      overlay.setAttribute("role", "dialog");
      overlay.setAttribute("aria-modal", "true");
      overlay.setAttribute("aria-labelledby", "pausetube-intent-title");
      overlay.innerHTML = `
        <div class="pausetube-intent-card">
          <h1 id="pausetube-intent-title">What are you here to watch?</h1>
          <p>Having a purpose helps you stay in control.</p>
          <input class="pausetube-intent-input" type="text" placeholder="e.g. Next.js tutorial, music for studying..." autofocus />
          <br />
          <button class="pausetube-intent-submit">Let's go</button>
          <br />
          <button class="pausetube-intent-skip">Just browsing</button>
        </div>
      `;

      const input = overlay.querySelector(".pausetube-intent-input");
      const submitBtn = overlay.querySelector(".pausetube-intent-submit");
      const skipBtn = overlay.querySelector(".pausetube-intent-skip");

      async function submit() {
        const intent = input.value.trim() || "Just browsing";
        await chrome.runtime.sendMessage({ type: "set-intent", intent });
        removeIntentPrompt();
        await fetchState();
        showIntentSticky();
      }

      submitBtn.addEventListener("click", submit);
      skipBtn.addEventListener("click", async () => {
        await chrome.runtime.sendMessage({ type: "set-intent", intent: "Just browsing" });
        removeIntentPrompt();
        await fetchState();
      });

      document.body.appendChild(overlay);
      lockScroll("intent");
      // Enter from the input reaches submit() through the trap — the capture-phase
      // listener stops the keydown before any listener on the input could run.
      releaseIntentFocus = trapFocus(overlay, { onEnter: submit });
      requestAnimationFrame(() => input.focus());
    }

    // Always tear the prompt down through here — the overlay owns a scroll lock
    // and a focus trap that a bare .remove() would strand.
    function removeIntentPrompt() {
      releaseIntentFocus?.();
      releaseIntentFocus = null;
      document.querySelector(".pausetube-intent-overlay")?.remove();
      unlockScroll("intent");
    }

    function showIntentSticky() {
      if (!currentState?.session?.intent) return;
      if (currentState.session.intent === "Just browsing") return;
      removeIntentSticky();

      stickyEl = document.createElement("div");
      stickyEl.className = "pausetube-intent-sticky";
      stickyEl.textContent = `🎯 ${currentState.session.intent}`;
      document.body.appendChild(stickyEl);
    }

    function removeIntentSticky() {
      if (stickyEl) {
        stickyEl.remove();
        stickyEl = null;
      }
    }

    // --- Toast ---

    function showToast() {
      document.querySelector(".pausetube-toast")?.remove();

      const snoozeCount = currentState?.session?.snoozeCount || 0;
      const totalSnoozedMs = currentState?.session?.totalSnoozedMs || 0;
      const totalMin = Math.round(totalSnoozedMs / 60000);
      const text = totalMin > 0
        ? `Snoozed ${snoozeCount}× · ${totalMin} min browsing`
        : `Snoozed ${snoozeCount}×`;

      const toast = document.createElement("div");
      toast.className = "pausetube-toast";
      toast.textContent = text;
      document.body.appendChild(toast);

      setTimeout(() => {
        toast.classList.add("pausetube-toast-hide");
        setTimeout(() => toast.remove(), 500);
      }, 4000);
    }

    function scheduleToastMidpoint() {
      clearTimeout(toastMidpointTimer);
      toastMidpointTimer = null;

      const expiresAt = currentState?.snooze?.expiresAt;
      if (!expiresAt) return;

      const remaining = expiresAt - Date.now();
      if (remaining < 10000) return;

      toastMidpointTimer = setTimeout(async () => {
        await fetchState();
        if (isSnoozed()) showToast();
      }, remaining / 2);
    }

    // --- Session Badge ---

    function createBadge() {
      if (badgeEl) return;

      badgeEl = document.createElement("div");
      badgeEl.className = "pausetube-badge";
      document.body.appendChild(badgeEl);
      updateBadge();
    }

    function updateBadge() {
      if (!badgeEl || !currentState?.session?.startTime) return;

      const elapsedBase = currentState.session.elapsedMs || 0;
      const runningElapsed = currentState.session.timerStartedAt
        ? Date.now() - currentState.session.timerStartedAt
        : 0;
      const elapsed = elapsedBase + runningElapsed;
      const videos = currentState.session.videoCount || 0;
      const { kind, minutes } = CONFIG.badgeState({
        elapsedMs: elapsed,
        highRiskMs: getSettings().highRiskMs,
        snooze: currentState.snooze,
      });

      badgeEl.className = `pausetube-badge pausetube-badge-${kind}`;

      let timeText;
      if (kind === "ok") timeText = `${minutes}m left`;
      else if (kind === "over") timeText = `${minutes}m over`;
      else if (minutes === null) timeText = "snoozed";
      else timeText = `${minutes}m snooze`;
      const text = `${timeText} · ${videos} video${videos !== 1 ? "s" : ""}`;

      badgeEl.innerHTML = `<span class="pausetube-badge-dot"></span>${text}`;

      // Pulse each minute ticked off the countdown to the gate.
      if (
        kind === "ok" &&
        lastDisplayedMinute !== null &&
        minutes !== lastDisplayedMinute &&
        !document.querySelector(".pausetube-feed-banner")
      ) {
        pulseMinute(minutes);
      }
      lastDisplayedMinute = kind === "ok" ? minutes : null;
    }

    function pulseMinute(min) {
      document.querySelector(".pausetube-minute-pulse-backdrop")?.remove();
      const backdrop = document.createElement("div");
      backdrop.className = "pausetube-minute-pulse-backdrop";
      const pulse = document.createElement("div");
      pulse.className = "pausetube-minute-pulse";
      pulse.textContent = `${min}`;
      backdrop.appendChild(pulse);
      document.body.appendChild(backdrop);
      setTimeout(() => backdrop.remove(), 1000);
    }

    // --- Lifecycle ---

    async function init() {
      removeStaleUI();
      await fetchState();
      applyRiskUI();

      // Intent prompt
      if (shouldShowIntent()) {
        showIntentPrompt();
      } else if (currentState?.session?.intent && currentState.session.intent !== "Just browsing") {
        showIntentSticky();
      }

      // Session badge
      createBadge();

      // Periodic badge updates and risk level checks
      badgeInterval = setInterval(async () => {
        await fetchState();
        if (stopIfOrphaned()) return;
        updateBadge();
        applyRiskUI();
      }, 10000);

      // Heartbeat to keep session alive
      heartbeatInterval = setInterval(() => {
        if (stopIfOrphaned()) return;
        chrome.runtime.sendMessage({ type: "heartbeat" }).catch(() => {});
      }, 60000);
    }

    // YouTube is an SPA — listen for navigation events
    function onNavigate() {
      if (stopIfOrphaned()) return;
      removeFeedHiddenBanner();
      fetchState().then(() => {
        applyRiskUI();
        updateBadge();
        if (shouldShowIntent()) {
          showIntentPrompt();
        } else if (currentState?.session?.intent && currentState.session.intent !== "Just browsing") {
          showIntentSticky();
        }
      });
    }

    // On tab becoming visible (laptop wake, tab switch back), immediately
    // sync state so a stale session is reset before the user sees it.
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") {
        if (stopIfOrphaned()) return;
        chrome.runtime.sendMessage({ type: "heartbeat" }).catch(() => {});
        fetchState().then(() => { updateBadge(); applyRiskUI(); });
      }
    });

    // YouTube fires this custom event on SPA navigation
    document.addEventListener("yt-navigate-finish", onNavigate);

    // Also watch for URL changes via History API
    let lastUrl = location.href;
    const urlObserver = new MutationObserver(() => {
      if (location.href !== lastUrl) {
        lastUrl = location.href;
        onNavigate();
      }
    });
    urlObserver.observe(document.body, { childList: true, subtree: true });

    // The popup snoozes via the background, so no click lands in this tab — it
    // asks the active tab to resume instead.
    chrome.runtime.onMessage.addListener((msg) => {
      if (msg.type === "resume-playback") resumePlayback();
    });

    // Cross-tab state sync. session/snooze/settings are a single source of truth
    // in chrome.storage.local; the background worker (and debug console) only ever
    // mutate them there. Reacting to storage changes — rather than to targeted
    // runtime messages — keeps every YouTube tab rendering off the same state no
    // matter which tab or context made the change, and no mutation site has to
    // remember to broadcast.
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local") return;
      if (!currentState) currentState = { session: {}, snooze: {}, settings: {} };

      if (changes.settings) {
        // Stored settings are sparse overrides — expand to the full effective set
        // so getSettings()/getRiskLevel() see every key. Re-apply immediately so a
        // changed threshold (e.g. a shorter gate time) takes effect without waiting
        // for the next interval tick.
        currentState.settings = CONFIG.effectiveSettings(changes.settings.newValue);
        applyRiskUI();
        updateBadge();
      }

      if (changes.snooze) {
        currentState.snooze = changes.snooze.newValue || {};
        applyRiskUI();
        updateBadge();

        if (currentState.snooze.active) {
          fetchState().then(() => {
            showToast();
            scheduleToastMidpoint();
          });
        } else {
          clearTimeout(toastMidpointTimer);
          toastMidpointTimer = null;
        }
      }

      if (changes.session) {
        const prevIntent = currentState.session?.intent ?? null;
        const session = changes.session.newValue || {};
        const newIntent = session.intent ?? null;
        currentState.session = session;

        // Only touch the prompt/sticky when the intent actually changed — session
        // writes also happen for routine lastActivity/timer bumps, which must not
        // make the sticky flicker. Reflect intent before applyRiskUI, since
        // getRiskLevel suppresses the breath banner while the prompt is on screen.
        if (newIntent !== prevIntent) {
          if (!newIntent) {
            removeIntentSticky();
            if (shouldShowIntent()) showIntentPrompt();
          } else {
            // Intent committed (here or in another tab) — drop any lingering
            // prompt and mirror the chosen goal.
            removeIntentPrompt();
            if (newIntent === "Just browsing") removeIntentSticky();
            else showIntentSticky();
          }
        }

        applyRiskUI();
        updateBadge();
      }
    });

    // Go
    init();
  },
});
