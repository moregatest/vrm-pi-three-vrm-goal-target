import { defineConfig } from 'vite';

// Browser runtime for the three-vrm PoC. Host pinned to loopback so the
// Playwright proof and the SSE bridge agree on origin.
export default defineConfig({
  server: { host: '127.0.0.1', strictPort: true },
  preview: { host: '127.0.0.1', strictPort: true },
  // three / @pixiv/three-vrm are large; raise the warn limit so build is quiet.
  build: { chunkSizeWarningLimit: 4000 },
});
