/// <reference types="astro/client" />

interface ImportMetaEnv {
  /**
   * Cesium Ion access token, baked into the client bundle at build time.
   * Set it in the Render dashboard (Environment) — never commit it. A scraped
   * client token is unavoidable for a static site, so scope it to read-only
   * access to just the World Imagery + World Terrain assets in Ion.
   */
  readonly PUBLIC_CESIUM_ION_TOKEN?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
