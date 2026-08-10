import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { VitePWA } from "vite-plugin-pwa";
import { bffDevPlugin } from "./vite/bff-dev-plugin";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig(({ mode }) => ({
	define: mode === "e2e" ? { "import.meta.env.VITE_E2E": JSON.stringify("1") } : undefined,
  envPrefix: ["VITE_", "NEXT_PUBLIC_"],
  plugins: [
    bffDevPlugin(mode),
    react(),
    mode !== "e2e" ? VitePWA({
      registerType: "autoUpdate",
      devOptions: {
        enabled: true,
      },
      includeAssets: ["favicon.ico", "favicon.png", "favicon-32.png", "apple-touch-icon.png"],
      manifest: {
        name: "GodCode Caja",
        short_name: "GodCode",
        description: "Sistema de Caja y Panel de Control de GodCode",
        theme_color: "#4F5BFF",
        background_color: "#16171d",
        display: "standalone",
        start_url: "/",
        scope: "/",
        orientation: "portrait-primary",
        icons: [
          {
            src: "/icon-192.png",
            sizes: "192x192",
            type: "image/png",
            purpose: "any",
          },
          {
            src: "/icon-512.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "any",
          },
          {
            src: "/icon-512.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "maskable",
          },
        ]
      },
      workbox: {
        globPatterns: ["**/*.{js,css,html,ico,png,svg,woff,woff2,json}"],
        cleanupOutdatedCaches: true,
        clientsClaim: true,
        skipWaiting: true,
        maximumFileSizeToCacheInBytes: 3 * 1024 * 1024, // 3 MiB to support Fondopublic.png (2.15 MB)
      },
    }) : null,
  ],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  optimizeDeps: {
    include: [
      "@radix-ui/react-slot",
      "@radix-ui/react-tabs",
      "@radix-ui/react-select",
      "@radix-ui/react-separator",
      "class-variance-authority",
      "clsx",
      "tailwind-merge",
      "use-sync-external-store",
      "use-sync-external-store/with-selector.js",
      "use-sync-external-store/shim/with-selector.js",
      "react-redux",
      "@reduxjs/toolkit",
    ],
    exclude: [],
  },
  server: {
    host: true,
    port: 5173,
  },
  preview: {
    host: true,
    port: 4173,
  },
}));
