import { refreshCapabilities } from "@polaris/hostd-client";
import { getCapabilities, type Capabilities } from "@polaris/config";

/**
 * The capability snapshot a page needs to decide whether the local host offers
 * `need`, without putting a daemon round trip in front of every paint.
 *
 * The background refresh (instrumentation.ts) keeps the snapshot current, so when
 * it already says the capability is there, that answer is served as it is. Only
 * when it says it is NOT is the daemon asked directly: that is the case where the
 * snapshot may simply be behind - hostd started a moment ago, or the first probe
 * after a restart has not come back yet - and a screen that said "not available"
 * for up to 30 seconds after it became available would be wrong in the way a
 * reader notices. Losing it is the rare direction, and whatever then fails to
 * reach the daemon says so in its own place.
 */
export async function capabilitiesFor(need: "docker" | "deploy"): Promise<Capabilities> {
    const cached = getCapabilities();
    return cached[need] ? cached : refreshCapabilities();
}
