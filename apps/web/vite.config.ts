import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// In development the API runs on :3000 (end-to-end tests point this elsewhere). Proxying
// avoids CORS and mirrors production, where both are served from one origin or
// VITE_API_URL points at the API.
const proxy = { '/v1': process.env.API_PROXY_TARGET ?? 'http://localhost:3000' };

export default defineConfig({
  plugins: [react()],
  server: { port: 5173, proxy },
  preview: { port: 4173, proxy },
});
