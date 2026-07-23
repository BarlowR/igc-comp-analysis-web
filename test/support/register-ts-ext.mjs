// Loaded via `node --import`: registers the extensionless-.ts resolve hook so the
// test runner can import competition.ts (which uses bundler-style relative imports).
import { register } from 'node:module';

register('./resolve-hook.mjs', import.meta.url);
