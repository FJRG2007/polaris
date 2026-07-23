/**
 * The bridge HTTP API. A thin, bearer-authenticated marshaller over the adapter
 * registry: connect/disconnect a channel and send a message. `/health` is an
 * unauthenticated liveness probe; everything else requires the shared bearer
 * token. The API is meant for the internal network only, never public.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { capabilitiesFor, connectChannelSchema, sendMessageSchema } from "@polaris/messaging";
import type { AdapterRegistry } from "./registry.js";

interface BridgeServerOptions {
    registry: AdapterRegistry;
    authToken: string;
}

async function readJson(req: IncomingMessage): Promise<unknown> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks).toString("utf8");
    return raw ? JSON.parse(raw) : {};
}

function reply(res: ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
}

export function createBridgeServer({ registry, authToken }: BridgeServerOptions): Server {
    async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
        const path = new URL(req.url ?? "/", "http://bridge").pathname;
        if (path === "/health") {
            reply(res, 200, { ok: true });
            return;
        }
        if (req.headers.authorization !== `Bearer ${authToken}`) {
            reply(res, 401, { error: "Unauthorized" });
            return;
        }
        try {
            if (req.method === "POST" && path === "/channels") {
                const parsed = connectChannelSchema.safeParse(await readJson(req));
                if (!parsed.success) {
                    reply(res, 400, { error: parsed.error.issues[0]?.message ?? "Invalid request" });
                    return;
                }
                const result = await registry.connect(parsed.data);
                reply(res, 200, {
                    externalId: result.externalId,
                    capabilities: capabilitiesFor(parsed.data.platform, parsed.data.provider)
                });
                return;
            }

            const stateMatch = path.match(/^\/channels\/([^/]+)\/state$/);
            if (req.method === "GET" && stateMatch) {
                const adapter = registry.get(decodeURIComponent(stateMatch[1]!));
                if (!adapter) {
                    reply(res, 404, { error: "Channel not connected" });
                    return;
                }
                reply(res, 200, adapter.getState ? adapter.getState() : { status: "connected" });
                return;
            }

            const sendMatch = path.match(/^\/channels\/([^/]+)\/send$/);
            if (req.method === "POST" && sendMatch) {
                const adapter = registry.get(decodeURIComponent(sendMatch[1]!));
                if (!adapter) {
                    reply(res, 404, { error: "Channel not connected" });
                    return;
                }
                const parsed = sendMessageSchema.safeParse(await readJson(req));
                if (!parsed.success) {
                    reply(res, 400, { error: parsed.error.issues[0]?.message ?? "Invalid request" });
                    return;
                }
                reply(res, 200, await adapter.send(parsed.data));
                return;
            }

            const channelMatch = path.match(/^\/channels\/([^/]+)$/);
            if (req.method === "DELETE" && channelMatch) {
                await registry.disconnect(decodeURIComponent(channelMatch[1]!));
                reply(res, 200, { ok: true });
                return;
            }

            reply(res, 404, { error: "Not found" });
        } catch (caught) {
            reply(res, 500, { error: caught instanceof Error ? caught.message : "Bridge error" });
        }
    }

    return createServer((req, res) => {
        void handle(req, res);
    });
}
