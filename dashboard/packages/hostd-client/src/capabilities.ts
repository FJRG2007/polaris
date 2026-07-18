/**
 * Edition detection. Probes the daemon and folds the result into the shared
 * capability holder in @polaris/config, so server code and the client capability
 * context read one consistent snapshot. A periodic refresh means the edition
 * degrades live if the daemon dies and upgrades if it comes online.
 */

import { deriveCapabilities, loadEnv, setCapabilities, type Capabilities } from "@polaris/config";
import { HostdClient } from "./client.js";

/** Probe once and update the shared capabilities. Returns the new snapshot. */
export async function refreshCapabilities(client = new HostdClient()): Promise<Capabilities> {
    const env = loadEnv();
    const health = await client.health();
    return setCapabilities(deriveCapabilities(health, { autoUpdateAllowed: env.POLARIS_AUTO_UPDATE }));
}

/**
 * Start a background refresh loop. Returns a stop function. Intended to run once
 * per server process; the interval is deliberately modest since edition changes
 * are rare (the daemon starting or stopping).
 */
export function startCapabilityRefresh(intervalMs = 30_000): () => void {
    const client = new HostdClient();
    void refreshCapabilities(client);
    const timer = setInterval(() => {
        void refreshCapabilities(client);
    }, intervalMs);
    timer.unref?.();
    return () => clearInterval(timer);
}
