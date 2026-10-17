import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// 桌面页面全部打包到本地，不依赖外部资源或常驻开发服务。
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: { host: "127.0.0.1", port: 1420, strictPort: true },
});
