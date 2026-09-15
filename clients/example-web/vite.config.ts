import { fileURLToPath, URL } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite-plus";

export default defineConfig({
  fmt: { ignorePatterns: ["dist/**", "src/vendor/bloub/**"] },
  lint: { ignorePatterns: ["dist/**", "src/vendor/bloub/**"] },
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  server: { fs: { allow: ["../.."] } },
  test: { environment: "happy-dom" },
});
