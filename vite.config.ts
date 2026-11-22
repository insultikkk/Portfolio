import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 1420,
    strictPort: true,
    watch: { ignored: ["**/src-tauri/**", "**/.cache/**"] },
  },
  clearScreen: false,
  build: { target: "es2022" },
  test: { include: ["src/**/*.test.ts"] },
});
