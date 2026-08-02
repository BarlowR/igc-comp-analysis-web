// @ts-check
import { defineConfig } from 'astro/config';

// Fully static, client-side-only app. No backend required.
// Cesium (the 3D tracklog viewer) is bundled via a normal ESM import; its static
// runtime assets (Workers/Assets/Widgets) are copied into public/cesium by
// scripts/copy-cesium-assets.mjs (run from `predev`/`prebuild`) and served at
// /cesium — the page sets window.CESIUM_BASE_URL to match.
export default defineConfig({
  output: 'static',
  // The archive listing IS the landing page; old /archive bookmarks land there
  // too (static build → a meta-refresh stub page). Day pages keep their
  // /archive/<comp>/<day> URLs.
  redirects: { '/archive': '/' },
  vite: {
    // Pre-optimise these at dev-server startup so their dep hashes are stable.
    // Without it, Vite discovers and re-optimises them mid-session, invalidating
    // the old URL ("504 Outdated Optimize Dep").
    //
    // Cesium is here because it is large. supabase-js is here because nothing
    // imports it statically — lib/supabase.ts loads it with a dynamic import, so
    // it misses the startup scan entirely and is only discovered when someone
    // actually signs in. If a build has rewritten node_modules/.vite in the
    // meantime (they share the directory), that discovery 504s instead of
    // re-optimising, and sign-in fails with "Failed to fetch dynamically
    // imported module" until the dev server is restarted.
    optimizeDeps: {
      include: ['cesium', '@supabase/supabase-js'],
    },
  },
});
