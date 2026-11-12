/**
 * Look up a block page's reference, from the Firewall screen.
 *
 * The visitor is told to quote the reference; this is where the operator it was
 * quoted to finds out what it was. The edge guard keeps its recent blocks in
 * memory (`@polaris/core` waf-block-log) and answers for one to a caller holding
 * the bearer both containers derive from the secret they already share, so the
 * lookup works on every install with nothing new in `.env`.
 */

import { loadEnv } from "@polaris/config";
import { guardUrl } from "@/lib/deploy/router";
import {
    WAF_BLOCK_LOOKUP_PATH,
    isWafBlockReference,
    parseWafBlockRecord,
    wafBlockLookupToken,
    type WafBlockRecord
} from "@polaris/core/waf";

/** What a lookup came back with. */
export type WafBlockLookup =
    | { readonly state: "found"; readonly block: WafBlockRecord }
    /** The edge does not hold it: too old, from before it last started, or mistyped. */
    | { readonly state: "unknown" }
    /** The edge answers but predates the lookup, so it has to be updated. */
    | { readonly state: "outdated" }
    /** The edge did not answer at all. */
    | { readonly state: "unreachable" };

const TIMEOUT_MS = 3000;

/** Ask the edge guard what one reference was. Never throws. */
export async function lookupWafBlock(reference: string): Promise<WafBlockLookup> {
    const wanted = reference.trim().toLowerCase();
    if (!isWafBlockReference(wanted)) return { state: "unknown" };
    let response: Response;
    try {
        response = await fetch(`${guardUrl()}${WAF_BLOCK_LOOKUP_PATH}${wanted}`, {
            headers: { authorization: `Bearer ${wafBlockLookupToken(loadEnv().POLARIS_AUTH_SECRET)}` },
            signal: AbortSignal.timeout(TIMEOUT_MS),
            cache: "no-store"
        });
    } catch {
        return { state: "unreachable" };
    }
    if (response.status === 404) {
        // A guard that predates the lookup treats the path as a forwardAuth check and
        // answers like one; only this guard's own 404 carries JSON.
        const json = (response.headers.get("content-type") ?? "").includes("application/json");
        return json ? { state: "unknown" } : { state: "outdated" };
    }
    if (!response.ok) return { state: response.status === 401 ? "unreachable" : "outdated" };
    const block = parseWafBlockRecord(await response.json().catch(() => null));
    if (!block || block.reference !== wanted) return { state: "outdated" };
    return { state: "found", block };
}
