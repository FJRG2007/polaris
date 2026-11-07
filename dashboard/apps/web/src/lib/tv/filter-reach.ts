/**
 * Whether a connected TV's lookups reach the Network filter: the address the TV
 * last called Polaris from, looked up among the devices the filter's log saw
 * over the last day. Read on its own, after the page, because it reads the log.
 */

import type { SeenDevice } from "@/lib/dns-blocker/query-log";

/**
 * - `reaching`: the filter saw lookups from the TV's address in the last day.
 * - `notReaching`: the filter runs and logs, and saw none.
 * - `filterOff`: no filter is running here.
 * - `unknown`: no address for the TV yet, or the filter keeps no log.
 */
export type TvFilterReach = "reaching" | "notReaching" | "filterOff" | "unknown";

/** "::ffff:192.168.1.20" and "192.168.1.20" are the same caller. */
function plain(address: string): string {
    return address
        .trim()
        .toLowerCase()
        .replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/, "");
}

export function reachOf(
    address: string | null,
    seen: { devices: readonly SeenDevice[]; logOff: boolean } | null
): TvFilterReach {
    if (!seen) return "filterOff";
    if (!address || seen.logOff) return "unknown";
    const wanted = plain(address);
    return seen.devices.some((device) => plain(device.address) === wanted && device.queries > 0)
        ? "reaching"
        : "notReaching";
}
