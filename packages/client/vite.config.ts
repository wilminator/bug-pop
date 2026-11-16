import { defineConfig } from 'vite';

// base './' lets the built site work from any folder or subdomain.
export default defineConfig({ base: './', build: { target: 'es2022' } });
