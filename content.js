// OffTube — Content Script
// Injected into YouTube pages: blur, intent prompt, floating badge

(function () {
  "use strict";

  let currentState = null;
  let badgeEl = null;
  let stickyEl = null;
  let badgeInterval = null;
  let toastMidpointTimer = null;
  let lastKnownSessionStart = null;
  let lastDisplayedMinute = null;

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
    const elapsed = getElapsedMs(currentState.session);
    const shortStreak = currentState.session?.shortStreak || 0;
    if (elapsed >= 2 * 60 * 1000 || shortStreak >= 3) return "high";
    return "none";
  }

  // --- Feed Hidden Banner ---

  async function handleSnoozeClick(minutes, videoLimit) {
    await chrome.runtime.sendMessage({ type: "start-snooze", minutes, videoLimit });
    await fetchState();
    applyRiskUI();
  }

  function runBreathing(banner, onComplete) {
    const circle = banner.querySelector(".offtube-breathe-circle");
    const viewport = banner.querySelector(".offtube-breathe-viewport");
    const strip = banner.querySelector(".offtube-breathe-strip");
    const steps = banner.querySelectorAll(".offtube-breathe-step");
    const countLabel = banner.querySelector(".offtube-breathe-count");

    const INHALE_S = 4;
    const EXHALE_S = 4;
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
    const breatheEl = banner.querySelector(".offtube-phase-breathe");
    const snoozeEl = banner.querySelector(".offtube-phase-snooze");
    breatheEl.classList.add("fading");
    setTimeout(() => {
      breatheEl.style.display = "none";
      snoozeEl.style.display = "flex";
      requestAnimationFrame(() => snoozeEl.classList.add("visible"));
    }, 300);
  }

  function showFeedHiddenBanner() {
    if (document.querySelector(".offtube-feed-banner")) return;

    const session = currentState?.session || {};
    const elapsed = getElapsedMs(session);
    const min = Math.floor(elapsed / 60000);
    const videos = session.videoCount || 0;
    const shortStreak = session.shortStreak || 0;
    const stateText = shortStreak >= 3
      ? `${shortStreak} Shorts in a row`
      : `${min} min here · ${videos} video${videos !== 1 ? "s" : ""}`;

    const banner = document.createElement("div");
    banner.className = "offtube-feed-banner";
    banner.innerHTML = `
      <div class="offtube-phase-breathe">
        <div class="offtube-breathe-title">Deep Breath</div>
        <div class="offtube-breathe-circle"></div>
        <div class="offtube-breathe-text">
          <div class="offtube-breathe-viewport">
            <div class="offtube-breathe-strip">
              <span class="offtube-breathe-step" data-phase="ready">ready</span>
              <span class="offtube-breathe-arrow">→</span>
              <span class="offtube-breathe-step" data-phase="inhale">inhale</span>
              <span class="offtube-breathe-arrow">→</span>
              <span class="offtube-breathe-step" data-phase="hold">hold</span>
              <span class="offtube-breathe-arrow">→</span>
              <span class="offtube-breathe-step" data-phase="exhale">exhale</span>
            </div>
          </div>
          <span class="offtube-breathe-count"></span>
        </div>
      </div>
      <div class="offtube-phase-snooze">
        <p class="offtube-snooze-state">${stateText}</p>
        <button class="offtube-choice-done">I'm done</button>
        <button class="offtube-choice-snooze" data-minutes="1">1 more min</button>
        <button class="offtube-choice-snooze" data-minutes="3">3 more min</button>
        <button class="offtube-choice-cancel">Cancel session</button>
      </div>
    `;

    banner.querySelectorAll("[data-minutes]").forEach((btn) => {
      btn.addEventListener("click", () => handleSnoozeClick(Number(btn.dataset.minutes), null));
    });

    banner.querySelector(".offtube-choice-done")?.addEventListener("click", () => {
      chrome.runtime.sendMessage({ type: "close-tab" });
    });

    banner.querySelector(".offtube-choice-cancel")?.addEventListener("click", async () => {
      await chrome.runtime.sendMessage({ type: "reset-session" });
      await fetchState();
      applyRiskUI();
      removeIntentSticky();
      if (shouldShowIntent()) showIntentPrompt();
    });

    document.body.appendChild(banner);
    runBreathing(banner, () => showSnoozePhase(banner));
  }

  function removeFeedHiddenBanner() {
    document.querySelector(".offtube-feed-banner")?.remove();
  }

  // --- Risk UI ---

  function applyRiskUI() {
    const risk = getRiskLevel();

    if (currentState?.session?.startTime !== lastKnownSessionStart) {
      lastKnownSessionStart = currentState?.session?.startTime || null;
      lastDisplayedMinute = null;
    }

    if (risk === "snoozed" || risk === "none") {
      document.documentElement.classList.remove("offtube-blur");
      removeFeedHiddenBanner();
      return;
    }

    // high
    document.documentElement.classList.add("offtube-blur");
    document.querySelectorAll("video").forEach((v) => v.pause());
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
    if (isSnoozed()) return false;
    if (currentState.session.intent) return false;
    if (isDirectVideoLink()) return false;
    return true;
  }

  function showIntentPrompt() {
    if (document.querySelector(".offtube-intent-overlay")) return;

    const overlay = document.createElement("div");
    overlay.className = "offtube-intent-overlay";
    overlay.innerHTML = `
      <div class="offtube-intent-card">
        <h1>What are you here to watch?</h1>
        <p>Having a purpose helps you stay in control.</p>
        <input class="offtube-intent-input" type="text" placeholder="e.g. Next.js tutorial, music for studying..." autofocus />
        <br />
        <button class="offtube-intent-submit">Let's go</button>
        <br />
        <button class="offtube-intent-skip">Just browsing</button>
      </div>
    `;

    const input = overlay.querySelector(".offtube-intent-input");
    const submitBtn = overlay.querySelector(".offtube-intent-submit");
    const skipBtn = overlay.querySelector(".offtube-intent-skip");

    async function submit() {
      const intent = input.value.trim() || "Just browsing";
      await chrome.runtime.sendMessage({ type: "set-intent", intent });
      overlay.remove();
      await fetchState();
      showIntentSticky();
    }

    submitBtn.addEventListener("click", submit);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") submit();
    });
    skipBtn.addEventListener("click", async () => {
      await chrome.runtime.sendMessage({ type: "set-intent", intent: "Just browsing" });
      overlay.remove();
      await fetchState();
    });

    document.body.appendChild(overlay);
    requestAnimationFrame(() => input.focus());
  }

  function showIntentSticky() {
    if (!currentState?.session?.intent) return;
    if (currentState.session.intent === "Just browsing") return;
    removeIntentSticky();

    stickyEl = document.createElement("div");
    stickyEl.className = "offtube-intent-sticky";
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
    document.querySelector(".offtube-toast")?.remove();

    const snoozeCount = currentState?.session?.snoozeCount || 0;
    const totalSnoozedMs = currentState?.session?.totalSnoozedMs || 0;
    const totalMin = Math.round(totalSnoozedMs / 60000);
    const text = totalMin > 0
      ? `Snoozed ${snoozeCount}× · ${totalMin} min browsing`
      : `Snoozed ${snoozeCount}×`;

    const toast = document.createElement("div");
    toast.className = "offtube-toast";
    toast.textContent = text;
    document.body.appendChild(toast);

    setTimeout(() => {
      toast.classList.add("offtube-toast-hide");
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
    badgeEl.className = "offtube-badge";
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
    const min = Math.floor(elapsed / 60000);
    const videos = currentState.session.videoCount || 0;
    const snoozed = isSnoozed();

    if (snoozed) {
      badgeEl.className = "offtube-badge offtube-badge-snoozed";
    } else {
      badgeEl.className = "offtube-badge";
    }

    let text = `${min}m · ${videos} video${videos !== 1 ? "s" : ""}`;
    if (snoozed) {
      text += " · snoozed";
    }

    badgeEl.innerHTML = `<span class="offtube-badge-dot"></span>${text}`;

    if (
      lastDisplayedMinute !== null &&
      min !== lastDisplayedMinute &&
      min > 0 &&
      !snoozed &&
      !document.querySelector(".offtube-feed-banner")
    ) {
      pulseMinute(min);
    }
    lastDisplayedMinute = min;
  }

  function pulseMinute(min) {
    document.querySelector(".offtube-minute-pulse-backdrop")?.remove();
    const backdrop = document.createElement("div");
    backdrop.className = "offtube-minute-pulse-backdrop";
    const pulse = document.createElement("div");
    pulse.className = "offtube-minute-pulse";
    pulse.textContent = `${min}`;
    backdrop.appendChild(pulse);
    document.body.appendChild(backdrop);
    setTimeout(() => backdrop.remove(), 1000);
  }

  // --- Lifecycle ---

  async function init() {
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
      updateBadge();
      applyRiskUI();
    }, 10000);

    // Heartbeat to keep session alive
    setInterval(() => {
      chrome.runtime.sendMessage({ type: "heartbeat" }).catch(() => {});
    }, 60000);
  }

  // YouTube is an SPA — listen for navigation events
  function onNavigate() {
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

  // Listen for messages from background
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === "snooze-changed") {
      const wasSnoozed = currentState?.snooze?.active === true;
      if (currentState) {
        currentState.snooze = msg.snooze;
      }
      applyRiskUI();
      updateBadge();

      if (msg.snooze.active) {
        if (!wasSnoozed) {
          document.querySelectorAll("video").forEach((v) => v.play().catch(() => {}));
        }
        fetchState().then(() => {
          showToast();
          scheduleToastMidpoint();
        });
      } else {
        clearTimeout(toastMidpointTimer);
        toastMidpointTimer = null;
      }
    }
    if (msg.type === "session-updated") {
      if (currentState) {
        currentState.session = msg.session;
      }
      applyRiskUI();
      updateBadge();

      if (!msg.session?.intent) {
        removeIntentSticky();
        if (shouldShowIntent()) showIntentPrompt();
      }
    }
  });

  // Go
  init();
})();
