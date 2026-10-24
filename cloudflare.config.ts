import { bindings, defineConfig, exports } from "cf/config";

// 线上部署：cf deploy。静态资源目录在 wrangler.config.ts 里（public/）。
export default defineConfig({
	worker: {
		name: "together-album",
		compatibilityDate: "2026-10-01",
		compatibilityFlags: ["nodejs_compat"],
		entrypoint: "worker/index.js",
		// 日志里去掉查询参数：分享者密钥和观看者 id 都在 WebSocket 地址的查询参数里
		observability: {
			enabled: true,
			redactQueryString: true,
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
			// TURN 中继密钥：cf workers secrets update 设置，用来为每次分享生成临时凭证
			TURN_KEY_ID: bindings.secret(),
			TURN_KEY_API_TOKEN: bindings.secret(),
			// 每次开始分享都会领一组中继凭证，限制同一地址开新分享的频率，防止有人批量领取
			CREATE_LIMIT: bindings.rateLimit({ namespace: "7301", simple: { limit: 6, period: 60 } }),
		},
		// 每个分享会话一个 Durable Object，用 SQLite 存储（免费计划可用）
		exports: {
			SessionRoom: exports.durableObject({ storage: "sqlite" }),
		},
	},
});
