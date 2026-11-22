// Bundles the relay and the workspace packages it uses into one file for Node (ws stays a dependency).
import { defineConfig } from 'vite';

export default defineConfig({
  ssr: { noExternal: [/^@bug-pop\//], external: ['ws'] },
  build: { ssr: 'src/main.ts', outDir: 'dist', target: 'node22', rollupOptions: { output: { entryFileNames: 'relay.js' } } },
});
