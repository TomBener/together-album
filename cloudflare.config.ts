import { bindings, defineConfig, exports } from "cf/config";

// 线上部署：cf deploy。静态资源目录在 wrangler.config.ts 里（public/）。
export default defineConfig({
	worker: {
		name: "together-album",
		compatibilityDate: "2026-10-01",
		compatibilityFlags: ["nodejs_compat"],
		entrypoint: "worker/index.js",
		observability: {
			enabled: true,
		},
		// 首页、加入页和接口先经过 Worker，其余文件直接由静态资源返回
		assets: {
			runWorkerFirst: ["/", "/v/*", "/api/*", "/healthz"],
		},
		domains: ["album.example.com"],
		env: {
			SESSIONS: bindings.durableObject({
				worker: "together-album",
				exportName: "SessionRoom",
			}),
			ASSETS: bindings.assets(),
		},
		// 每个分享会话一个 Durable Object，用 SQLite 存储（免费计划可用）
		exports: {
			SessionRoom: exports.durableObject({ storage: "sqlite" }),
		},
	},
});
