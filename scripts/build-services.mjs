// Bundles each service (with the shared workspace packages) into services/<name>/dist/main.js.
// npm dependencies stay external and are installed in the Docker image.
import { build } from 'esbuild';
import { existsSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const services = readdirSync(resolve(root, 'services')).filter((name) => existsSync(resolve(root, 'services', name, 'src', 'main.ts')));

for (const name of services) {
  await build({
    entryPoints: [resolve(root, 'services', name, 'src', 'main.ts')],
    outfile: resolve(root, 'services', name, 'dist', 'main.js'),
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'esm',
    sourcemap: true,
    packages: 'external',
    // Workspace packages are TypeScript sources: bundle them instead of leaving them external.
    plugins: [
      {
        name: 'bundle-workspace',
        setup(b) {
          b.onResolve({ filter: /^@talkie\// }, (args) => {
            const pkg = args.path.split('/')[1];
            return { path: resolve(root, 'packages', pkg, 'src', 'index.ts') };
          });
        },
      },
    ],
    banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
    logLevel: 'warning',
  });
  console.log(`built services/${name}/dist/main.js`);
}
