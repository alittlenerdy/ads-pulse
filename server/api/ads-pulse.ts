/** Vercel Node function: deploy the server/ folder as a Vercel project, then GET /api/ads-pulse. */
import type { IncomingMessage, ServerResponse } from "node:http";
import { handle } from "../src/handler";

export const config = { maxDuration: 60 };

export default async function handler(req: IncomingMessage, res: ServerResponse) {
	const url = new URL(req.url ?? "/", `https://${req.headers.host ?? "localhost"}`);
	const out = await handle(req.headers.authorization, url);
	res.statusCode = out.status;
	res.setHeader("content-type", "application/json");
	res.setHeader("cache-control", "no-store");
	res.end(JSON.stringify(out.body));
}
