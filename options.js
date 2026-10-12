// PauseTube — Options page
// Renders a settings form straight from the shared SETTINGS_SCHEMA and saves
// (auto-saves on change) through the background's set-settings handler, which
// clamps and stores overrides sparsely. Number knobs are shown in display units
// (value / scale) and converted back on save.

const CONFIG = self.PauseTubeConfig;
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
    control =
      `<input type="text" id="${id}" data-key="${spec.key}" placeholder="e.g. 1, 5, 10" />` +
      `<span class="unit">min</span>`;
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
}

// --- Values ---

function loadValues(settings) {
  for (const spec of SETTINGS_SCHEMA) {
    const el = document.getElementById(controlId(spec.key));
    const v = settings[spec.key];
    if (spec.type === "bool") el.checked = Boolean(v);
    else if (spec.type === "number") el.value = v / spec.scale;
    else if (spec.type === "minutes-list") el.value = (v || []).join(", ");
  }
}

function readValue(spec, el) {
  if (spec.type === "bool") return el.checked;
  if (spec.type === "number") {
    const n = Number(el.value);
    return Number.isFinite(n) ? Math.round(n * spec.scale) : undefined;
  }
  if (spec.type === "minutes-list") {
    return el.value
      .split(",")
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isFinite(n));
  }
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

async function onChange(e) {
  if (!e.target.dataset.key) return;
  await chrome.runtime.sendMessage({ type: "set-settings", settings: collectPatch() });
  flash("Saved");
  await reload(); // reflect any clamping the background applied
}

document.getElementById("reset").addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "set-settings", settings: CONFIG.DEFAULT_SETTINGS });
  flash("Reset to defaults");
  await reload();
});

// --- Init ---

buildForm();
reload();
