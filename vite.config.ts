import { defineConfig } from "vite";

export default defineConfig({
  server: { proxy: { "/_push": "http://127.0.0.1:3001" } },
});
