import { defineConfig } from "vite";
import solid from "vite-plugin-solid";

export default defineConfig({
  // Relative base keeps the static build portable, including GitHub Pages subpaths.
  base: "./",
  plugins: [solid()],
  build: {
    target: ["safari16", "chrome110"],
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: true,
  },
});
