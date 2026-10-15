import { defineConfig } from "wxt";

const ICONS = {
  16: "icons/icon16.png",
  48: "icons/icon48.png",
  128: "icons/icon128.png",
};

// The manifest is generated from this config plus the entrypoints/ folder.
// name, version and description come from package.json.
export default defineConfig({
  manifest: {
    name: "PauseTube",
    homepage_url: "https://pausetube.com",
    permissions: ["storage", "scripting", "tabs", "webNavigation", "alarms"],
    host_permissions: ["https://www.youtube.com/*"],
    icons: ICONS,
    action: { default_icon: ICONS },
  },
});
