import { VitePWA } from "vite-plugin-pwa";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import generouted from "@generouted/react-router/plugin";
import tailwindcss from "@tailwindcss/vite";

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [
    react(),
    generouted(),
    tailwindcss(),
    VitePWA({
      registerType: "autoUpdate",
      injectRegister: "auto",

      manifest: {
        name: "Calorie Counter",
        short_name: "Calorie Counter",
        description: "Track your daily calories and meals",
        theme_color: "#e2e2e2",
        icons: [
          {
            src: "icon.webp",
            sizes: "1024x1024",
            type: "image/png",
            purpose: "any maskable",
          },
        ],
      },

      workbox: {
        globPatterns: ["**/*.{js,css,html,svg,png,ico,wasm}"],
        cleanupOutdatedCaches: true,
        clientsClaim: true,
      },

      devOptions: {
        enabled: false,
        navigateFallback: "index.html",
        suppressWarnings: true,
        type: "module",
      },
    }),
  ],
  server: {
    fs: {
      allow: [".."],
    },
    headers: {
      "Cross-Origin-Embedder-Policy": "require-corp",
      "Cross-Origin-Opener-Policy": "same-origin",
    },
  },
  optimizeDeps: {
    exclude: ["@sqlite.org/sqlite-wasm"],
  },
  worker: {
    format: "es",
  },
});
