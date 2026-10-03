// Builds ui/view.html into one self-contained file, dist/view.html: the host loads the view with
// no network, so scripts and styles must be inline.
import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

export default defineConfig({
  root: "ui",
  plugins: [viteSingleFile()],
  build: {
    outDir: "../dist",
    emptyOutDir: true,
    rollupOptions: { input: "ui/view.html" },
  },
});
