// Serves tests/browser/index.html at every address, so a deep URL or a reload
// lands on the navigation harness (see navigation.check.cjs).
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({ root: __dirname, plugins: [react()], server: { port: 5197, strictPort: true } });
