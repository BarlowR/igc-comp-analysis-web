// Resolve hook: lets `import './foo'` (extensionless, bundler-style) load './foo.ts'
// under `node --test`, so competition.ts / igc.ts and their relative deps import
// without a bundling step. Only touches relative specifiers that have no extension.
export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('.')) {
    const base = specifier.split('/').pop();
    if (!base.includes('.')) {
      try {
        return await nextResolve(specifier + '.ts', context);
      } catch {
        // fall through to default resolution
      }
    }
  }
  return nextResolve(specifier, context);
}
