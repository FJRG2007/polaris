/**
 * Reading the edge's access log for the firewall's own analytics. The folding is
 * pure and lives in @polaris/core; this is the file read around it, sharing the same
 * bounded-tail approach the jail runner uses so a log that has grown for months is
 * never loaded whole.
 */

import { readFile } from "node:fs/promises";
import { parseHttpLogs } from "@polaris/deploy";
import { summarizeWafTraffic, type WafTrafficSummary } from "@polaris/core";

const ACCESS_LOG_FILE = process.env.POLARIS_TRAEFIK_ACCESSLOG ?? "/traefik-log/access.log";

/** Sized for a day of traffic on a busy instance. Beyond this the window simply
 *  starts later, which the summary reports rather than hides. */
const TAIL_BYTES = 16 * 1024 * 1024;

/** Traffic over the last `hours`, split into allowed and blocked, with the
 *  breakdowns of what was turned away. */
export async function wafTraffic(hours = 24, now = Date.now()): Promise<WafTrafficSummary> {
    const from = now - hours * 3600 * 1000;
    let raw: string;
    try {
        raw = await readFile(ACCESS_LOG_FILE, "utf8");
    } catch {
        // No edge log on this deployment (or not mounted): an empty summary, which
        // the panel renders as "nothing recorded yet" rather than as zero attacks.
        return summarizeWafTraffic([], from, now);
    }
    if (raw.length > TAIL_BYTES) {
        const cut = raw.slice(raw.length - TAIL_BYTES);
        raw = cut.slice(cut.indexOf("\n") + 1);
    }
    return summarizeWafTraffic(parseHttpLogs(raw), from, now);
}
