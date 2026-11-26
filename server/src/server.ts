/** Self-hosted server: `npm start` (PORT, default 8787). GET /api/ads-pulse with Authorization: Bearer <ADS_PULSE_TOKEN>. */
import http from "node:http";
import { handle } from "./handler";

const port = Number(process.env.PORT || 8787);

http
	.createServer(async (req, res) => {
		const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
		if (url.pathname === "/healthz") {
			res.writeHead(200, { "content-type": "application/json" }).end('{"ok":true}');
			return;
		}
		if (req.method !== "GET" || url.pathname !== "/api/ads-pulse") {
			res.writeHead(404, { "content-type": "application/json" }).end('{"error":"Not found"}');
			return;
		}
		try {
			const out = await handle(req.headers.authorization, url);
			res.writeHead(out.status, { "content-type": "application/json", "cache-control": "no-store" }).end(JSON.stringify(out.body));
		} catch (e) {
			res.writeHead(500, { "content-type": "application/json" }).end(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }));
		}
	})
	.listen(port, () => console.log(`ads-pulse listening on http://localhost:${port}/api/ads-pulse`));
