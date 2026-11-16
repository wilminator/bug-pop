import { execSync } from 'node:child_process';
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

// base './' lets the built site work from any folder or subdomain.
export default defineConfig({
  base: './',
  build: { target: 'es2022' },
  define: { __BUILD_ID__: JSON.stringify(BUILD_ID) },
  plugins: [versionFile()],
});
