// SPDX-License-Identifier: AGPL-3.0-only

import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// apps/server serves dist/ under /editor-assets/ and answers /orgs/:org/spaces/:space/edit
// with dist/index.html, so every asset URL starts with that prefix.
export default defineConfig({
  base: '/editor-assets/',
  plugins: [react()],
  build: {
    outDir: 'dist',
    assetsDir: '',
    emptyOutDir: true,
    sourcemap: true,
    // React and CodeMirror in one chunk; the editor is one authenticated page.
    chunkSizeWarningLimit: 1200,
  },
});
