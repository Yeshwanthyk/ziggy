import { fileURLToPath, URL } from "node:url";
import { copyFileSync } from "node:fs";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite-plus";

export default defineConfig({
  build: {
    rollupOptions: {
      output: {
        assetFileNames: "assets/[name][extname]",
        entryFileNames: "assets/app.js",
      },
    },
  },
  fmt: { ignorePatterns: ["dist/**", "src/vendor/bloub/**"] },
  lint: { ignorePatterns: ["dist/**", "src/vendor/bloub/**"] },
  plugins: [
    react(),
    tailwindcss(),
    {
      name: "ziggy-standalone-index",
      closeBundle: () => copyFileSync("dist/index.html", "dist/index.embed"),
    },
  ],
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  server: { fs: { allow: ["../.."] } },
  test: { environment: "happy-dom" },
});
