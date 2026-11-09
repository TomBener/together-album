import { bindings, defineConfig, exports } from "cf/config";

// 线上部署：cf deploy。静态资源目录在 wrangler.config.ts 里（public/）。
// 自定义域名写在 .env 的 ALBUM_DOMAIN 里，不提交到仓库；没有时只用 workers.dev 地址。
try {
	process.loadEnvFile();
} catch (error) {
	if ((error as { code?: string }).code !== "ENOENT") throw error;
}
const domain = process.env.ALBUM_DOMAIN;

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
		domains: domain ? [domain] : [],
		env: {
			SESSIONS: bindings.durableObject({
				worker: "together-album",
				exportName: "SessionRoom",
			}),
			ASSETS: bindings.assets(),
			// TURN 中继密钥：部署时传入，用来为每次分享生成临时凭证。见 README 的“部署”一节
			TURN_KEY_ID: bindings.secret(),
			TURN_KEY_API_TOKEN: bindings.secret(),
			// 每次开始分享都会领一组中继凭证，限制同一地址开新分享的频率，防止有人批量领取
			CREATE_LIMIT: bindings.rateLimit({ namespace: "7301", simple: { limit: 10, period: 60 } }),
		},
		// 每个分享会话一个 Durable Object，用 SQLite 存储（免费计划可用）
		exports: {
			SessionRoom: exports.durableObject({ storage: "sqlite" }),
		},
	},
});
