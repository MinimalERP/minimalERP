import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';

export default defineConfig({
  plugins: [preact()],
  // GitHub Pages serves a project site from /<repo>/; the Pages workflow sets VITE_BASE. Everywhere else (dev, tests) it is the root.
  base: process.env['VITE_BASE'] ?? '/',
  build: {
    target: 'es2022',
    sourcemap: true,
  },
});
