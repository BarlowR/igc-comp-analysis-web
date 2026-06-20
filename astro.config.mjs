// @ts-check
import { defineConfig } from 'astro/config';

// Fully static, client-side-only app. No backend required.
export default defineConfig({
  output: 'static',
});
