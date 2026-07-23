/**
 * Messaging bridge entrypoint. Runs the enabled channel adapters behind the
 * bearer-authenticated HTTP API and forwards each inbound message to the web's
 * ingest route (loopback, shared-key authenticated), which persists it and fans
 * it out to the inbox. Deployed by Polaris as a managed container so its
 * Puppeteer/whatsapp-web weight stays isolated from the web process.
 */

import { AdapterRegistry } from "./registry.js";
import { createBridgeServer } from "./server.js";
import type { InboundMessage } from "@polaris/messaging";

const port = Number(process.env.BRIDGE_PORT ?? 8787);
const authToken = process.env.BRIDGE_TOKEN ?? "";
const ingestUrl = (process.env.WEB_INGEST_URL ?? "").replace(/\/+$/, "");
const ingestKey = process.env.WEB_INGEST_KEY ?? "";

if (!authToken) {
    console.warn("messaging-bridge: BRIDGE_TOKEN is unset; the API would be unauthenticated - refusing risky start.");
}
if (!ingestUrl) {
    console.warn("messaging-bridge: WEB_INGEST_URL is unset; inbound messages have nowhere to be delivered.");
}

async function forwardInbound(message: InboundMessage): Promise<void> {
    if (!ingestUrl) return;
    try {
        await fetch(ingestUrl, {
            method: "POST",
            headers: { "content-type": "application/json", "x-internal-key": ingestKey },
            body: JSON.stringify(message)
        });
    } catch (caught) {
        console.error(`messaging-bridge: inbound forward failed: ${caught instanceof Error ? caught.message : caught}`);
    }
}

const registry = new AdapterRegistry((message) => {
    void forwardInbound(message);
});

createBridgeServer({ registry, authToken }).listen(port, () => {
    console.log(`messaging-bridge listening on :${port}`);
});
