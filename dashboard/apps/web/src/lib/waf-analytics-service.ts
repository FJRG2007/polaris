/**
 * Reading the edge's access log for the firewall's own analytics. The folding is
 * pure and lives in @polaris/core; this is the file read around it, sharing the same
 * bounded-tail approach the jail runner uses so a log that has grown for months is
 * never loaded whole.
 */

import { parseHttpLogs } from "@polaris/deploy";
import { EDGE_LOG_WINDOW_BYTES, readEdgeLogTail } from "@/lib/edge-access-log";
import {
    summarizeWafAddress,
    summarizeWafTraffic,
    type WafAddressActivity,
    type WafTrafficEntry,
    type WafTrafficSummary
} from "@polaris/core";

/**
 * The parsed log and the window it is being read over.
 *
 * Handed out rather than folded, for the one caller that replays the rules over the
 * traffic instead of summarizing it. Same read, same bounded tail: a second reader
 * with its own file handling would be a second answer about the same window.
 */
export async function wafLogWindow(
    hours = 24,
    now = Date.now()
): Promise<{ entries: WafTrafficEntry[]; from: number; to: number }> {
    return {
        entries: parseHttpLogs(await readEdgeLogTail(EDGE_LOG_WINDOW_BYTES)),
        from: now - hours * 3600 * 1000,
        to: now
    };
}

/** Traffic over the last `hours`, split into allowed and blocked, with the
 *  breakdowns of what was turned away. */
export async function wafTraffic(hours = 24, now = Date.now()): Promise<WafTrafficSummary> {
    const from = now - hours * 3600 * 1000;
    // An empty log summarizes to "nothing recorded yet" rather than to zero attacks.
    return summarizeWafTraffic(
        parseHttpLogs(await readEdgeLogTail(EDGE_LOG_WINDOW_BYTES)),
        from,
        now
    );
}

/**
 * What one address did, over the same log.
 *
 * Read on demand rather than kept: the evidence behind a ban is looked at once, by one
 * person, minutes after the ban - storing a per-address request history to serve that
 * would be a write on every request for something almost nobody opens.
 */
export async function wafAddressActivity(
    ip: string,
    hours = 24,
    now = Date.now()
): Promise<WafAddressActivity> {
    return summarizeWafAddress(
        parseHttpLogs(await readEdgeLogTail(EDGE_LOG_WINDOW_BYTES)),
        ip,
        now - hours * 3600 * 1000,
        now
    );
}
