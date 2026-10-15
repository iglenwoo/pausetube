// PauseTube — Options page
// Renders a settings form straight from the shared SETTINGS_SCHEMA and saves
// (auto-saves on change) through the background's set-settings handler, which
// clamps and stores overrides sparsely. Number knobs are shown in display units
// (value / scale) and converted back on save. Minute lists are edited as chips:
// "+ Add" opens a small input, × removes one.

import { PauseTubeConfig as CONFIG } from "@/utils/config";

const { SETTINGS_SCHEMA } = CONFIG;

const form = document.getElementById("form");
const statusEl = document.getElementById("status");

const controlId = (key) => "opt-" + key;
const esc = (v) => String(v).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

let statusTimer = null;
function flash(msg) {
  statusEl.textContent = msg;
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => { statusEl.textContent = ""; }, 1800);
}

// --- Rendering ---

function fieldHtml(spec) {
  const id = controlId(spec.key);
  let control = "";
  if (spec.type === "bool") {
    control = `<input type="checkbox" id="${id}" data-key="${spec.key}" />`;
  } else if (spec.type === "number") {
    control =
      `<input type="number" id="${id}" data-key="${spec.key}"
        min="${spec.min / spec.scale}" max="${spec.max / spec.scale}" step="${spec.step / spec.scale}" />` +
      `<span class="unit">${esc(spec.unit)}</span>`;
  } else if (spec.type === "minutes-list") {
    control = `<div class="chips" id="${id}" data-key="${spec.key}"></div>`;
  }
  return `
    <div class="field">
      <label for="${id}">
        <span class="field-label">${esc(spec.label)}</span>
        ${spec.help ? `<span class="field-help">${esc(spec.help)}</span>` : ""}
      </label>
      <div class="control">${control}</div>
    </div>`;
}

function buildForm() {
  const order = [];
  const byGroup = new Map();
  for (const spec of SETTINGS_SCHEMA) {
    if (!byGroup.has(spec.group)) { byGroup.set(spec.group, []); order.push(spec.group); }
    byGroup.get(spec.group).push(spec);
  }
  form.innerHTML = order
    .map(
      (g) => `<section class="panel"><h2>${esc(g)}</h2>${byGroup.get(g).map(fieldHtml).join("")}</section>`
    )
    .join("");
  form.addEventListener("change", onChange);
  form.addEventListener("click", onChipClick);
  form.addEventListener("submit", (e) => e.preventDefault());
}

// --- Minute chips ---

function renderChips(el, minutes) {
  el.dataset.values = JSON.stringify(minutes);
  // Keep at least one: an empty list isn't valid and would fall back to defaults.
  const removable = minutes.length > 1;
  el.innerHTML =
    minutes
      .map(
        (m) => `<span class="chip">${m} min${
          removable
            ? `<button type="button" class="chip-remove" data-minutes="${m}" aria-label="Remove ${m} min">×</button>`
            : ""
        }</span>`
      )
      .join("") + `<button type="button" class="chip-add">+ Add</button>`;
}

function chipValues(el) {
  return JSON.parse(el.dataset.values || "[]");
}

function onChipClick(e) {
  const chips = e.target.closest(".chips");
  if (!chips) return;

  if (e.target.classList.contains("chip-remove")) {
    const m = Number(e.target.dataset.minutes);
    renderChips(chips, chipValues(chips).filter((v) => v !== m));
    save();
  } else if (e.target.classList.contains("chip-add")) {
    openChipInput(chips, e.target);
  }
}

function openChipInput(chips, addBtn) {
  const input = document.createElement("input");
  input.type = "number";
  input.className = "chip-input";
  input.min = "1";
  input.max = "180";
  input.placeholder = "min";
  input.setAttribute("aria-label", "Minutes to add");
  addBtn.replaceWith(input);
  input.focus();

  let done = false;
  const finish = (commit) => {
    if (done) return;
    done = true;
    const n = Math.round(Number(input.value));
    const values = chipValues(chips);
    if (commit && input.value !== "" && n >= 1 && n <= 180 && !values.includes(n)) {
      renderChips(chips, [...values, n].sort((a, b) => a - b));
      save();
    } else {
      renderChips(chips, values);
    }
  };
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); finish(true); }
    else if (e.key === "Escape") finish(false);
  });
  input.addEventListener("blur", () => finish(true));
}

// --- Values ---

function loadValues(settings) {
  for (const spec of SETTINGS_SCHEMA) {
    const el = document.getElementById(controlId(spec.key));
    const v = settings[spec.key];
    if (spec.type === "bool") el.checked = Boolean(v);
    else if (spec.type === "number") el.value = v / spec.scale;
    else if (spec.type === "minutes-list") renderChips(el, v || []);
  }
}

function readValue(spec, el) {
  if (spec.type === "bool") return el.checked;
  if (spec.type === "number") {
    const n = Number(el.value);
    return Number.isFinite(n) ? Math.round(n * spec.scale) : undefined;
  }
  if (spec.type === "minutes-list") return chipValues(el);
}

function collectPatch() {
  const patch = {};
  for (const spec of SETTINGS_SCHEMA) {
    const el = document.getElementById(controlId(spec.key));
    const v = readValue(spec, el);
    if (v !== undefined) patch[spec.key] = v;
  }
  return patch;
}

async function reload() {
  const state = await chrome.runtime.sendMessage({ type: "get-state" });
  loadValues(state?.settings || CONFIG.DEFAULT_SETTINGS);
}

// --- Events ---

async function save() {
  await chrome.runtime.sendMessage({ type: "set-settings", settings: collectPatch() });
  flash("Saved");
  await reload(); // reflect any clamping the background applied
}

function onChange(e) {
  if (!e.target.dataset.key) return;
  save();
}

document.getElementById("reset").addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "set-settings", settings: CONFIG.DEFAULT_SETTINGS });
  flash("Reset to defaults");
  await reload();
});

// --- Init ---

buildForm();
reload();
