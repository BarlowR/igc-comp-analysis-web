// @ts-check
import { defineConfig } from 'astro/config';

// Fully static, client-side-only app. No backend required.
// Cesium (the 3D tracklog viewer) is bundled via a normal ESM import; its static
// runtime assets (Workers/Assets/Widgets) are copied into public/cesium by
// scripts/copy-cesium-assets.mjs (run from `predev`/`prebuild`) and served at
// /cesium — the page sets window.CESIUM_BASE_URL to match.
export default defineConfig({
  output: 'static',
  vite: {
    // Cesium is large; pre-optimise it at dev-server startup so its dep hash is
    // stable. Without this, Vite discovers and re-optimises it mid-session,
    // invalidating the old URL ("504 Outdated Optimize Dep").
    optimizeDeps: {
      include: ['cesium'],
    },
  },
});
