import { execSync } from 'node:child_process';
import { readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { defineConfig, type Plugin } from 'vite';

// Every build gets an id: the git commit it was built from, plus the build time so two
// builds of the same commit (e.g. a config change) still count as different. The id is
// baked into the code and also written to version.json; the running game compares the
// two to notice that a newer build has been deployed (see src/update.ts).
function buildId(): string {
  let sha = process.env.WORKERS_CI_COMMIT_SHA ?? '';
  if (!sha) {
    try { sha = execSync('git rev-parse HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch { sha = 'dev'; }
  }
  return `${sha.slice(0, 12)}-${Date.now().toString(36)}`;
}

const BUILD_ID = buildId();

const versionFile = (): Plugin => ({
  name: 'bug-pop-version',
  apply: 'build',
  generateBundle() {
    this.emitFile({ type: 'asset', fileName: 'version.json', source: JSON.stringify({ version: BUILD_ID }) + '\n' });
  },
});

// precache.json: every file in the built site, for the service worker to fetch in the
// background so the game works offline from the first visit (public/sw.js, fillCache).
// Files the service worker never caches, or that only matter to the host, are left out.
const SKIP = new Set(['_headers', 'precache.json', 'version.json', 'sw.js']);
function writePrecacheList(dir: string) {
  const files: string[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d).sort()) {
      const full = join(d, name);
      if (statSync(full).isDirectory()) walk(full);
      else {
        const rel = relative(dir, full).split(sep).join('/');
        if (!SKIP.has(rel)) files.push(rel === 'index.html' ? './' : rel);
      }
    }
  };
  walk(dir);
  writeFileSync(join(dir, 'precache.json'), JSON.stringify({ files }, null, 1) + '\n');
}
const precacheList = (): Plugin => {
  let outDir = 'dist';
  return {
    name: 'bug-pop-precache',
    apply: 'build',
    configResolved(c) { outDir = resolve(c.root, c.build.outDir); },
    closeBundle() { writePrecacheList(outDir); },
  };
};

// base './' lets the built site work from any folder or subdomain.
export default defineConfig({
  base: './',
  build: { target: 'es2022' },
  define: { __BUILD_ID__: JSON.stringify(BUILD_ID) },
  plugins: [versionFile(), precacheList()],
});
