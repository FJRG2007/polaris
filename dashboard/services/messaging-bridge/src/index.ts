/**
 * Messaging bridge entrypoint. Runs the enabled channel adapters behind the
 * bearer-authenticated HTTP API, which Polaris calls to connect channels and send
 * alerts, notices and sign-in codes through them. Inbound messages are not
 * forwarded anywhere. Deployed by Polaris as a managed container so its
 * Puppeteer/whatsapp-web weight stays isolated from the web process.
 */

import { AdapterRegistry } from "./registry.js";
import { createBridgeServer } from "./server.js";

const port = Number(process.env.BRIDGE_PORT ?? 8787);
const authToken = process.env.BRIDGE_TOKEN ?? "";

if (!authToken) {
    console.error(
        "messaging-bridge: BRIDGE_TOKEN is unset; refusing to start an unauthenticated API."
    );
    process.exit(1);
}
// Inbound messages fed the retired Inbox; adapters still report them, and they
// are dropped here.
const registry = new AdapterRegistry(() => {});

const server = createBridgeServer({ registry, authToken });
server.listen(port, () => {
    console.log(`messaging-bridge listening on :${port}`);
});

// Graceful shutdown: on stop/restart, close every adapter before exiting so
// whatsapp-web's Chromium is destroyed cleanly (its LocalAuth session survives a
// clean destroy but not an abrupt kill). Bounded well under Docker's ~10s stop
// grace so we exit before SIGKILL.
let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`messaging-bridge: ${signal} received, closing adapters...`);
    const hardExit = setTimeout(() => process.exit(0), 9000);
    try {
        await registry.disconnectAll();
        server.close();
    } catch (caught) {
        console.error(
            `messaging-bridge: shutdown error: ${caught instanceof Error ? caught.message : caught}`
        );
    } finally {
        clearTimeout(hardExit);
        process.exit(0);
    }
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
