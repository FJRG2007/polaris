/**
 * The page a blocked visitor gets, in place of a bare "Forbidden".
 *
 * A block is the one firewall outcome an ordinary person sees, and most of the people
 * who see it are not attackers: a visitor on a shared address, a request that tripped a
 * signature, an operator testing their own rule. A blank 403 tells all of them nothing
 * and leaves the site owner with nothing to be asked about, so a block answers with a
 * page that says what happened and carries a reference to quote.
 *
 * It lives here because a block is decided in two places that share nothing else: the
 * edge guard, which refuses a request on the app's own domain, and Polaris, which
 * refuses to mint an edge login for an account the rule does not admit. Two pages would
 * drift, and the second one is reached by the same visitor as the first.
 *
 * What the guard's page deliberately does not say is WHICH rule matched. The reason
 * travels with the decision, for the operator; on the page it would let anyone map the
 * ruleset by probing it until the wording changed. `explanation` exists for the case
 * where the block CAN safely say more - a signed-in account refused by name already
 * knows who it is.
 *
 * The reference is the caller's to generate, and today nothing generates one that
 * outlives the response: it gives a visitor something to quote and the page the shape it
 * keeps once blocks are recorded, at which point this becomes the recorded id.
 */

import { edgePage, edgeText } from "./edge-page.js";

/** What the page says about the request it refused. */
export interface WafBlockPageInput {
    /** An id for the visitor to quote back. */
    readonly reference: string;
    /** The site the request was for, so a visitor knows which one refused them. */
    readonly host?: string;
    /** The address the firewall judged (leftmost X-Forwarded-For). */
    readonly ip?: string | null;
    /** Replaces the default "why", for a block whose reason is safe to state. */
    readonly explanation?: string;
}

/** The default "why", which describes the class of blocks rather than the rule. */
const DEFAULT_EXPLANATION =
    "This site runs a firewall. Something about this request matched a rule that blocks it, either where it came from or what it carried.";

/** A shield, drawn as the contents of a stroked 24x24 viewBox. */
const SHIELD =
    '<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/><path d="M12 8v4"/><path d="M12 16h.01"/>';

/** Render the block page for one refused request. */
export function wafBlockPage(input: WafBlockPageInput): string {
    return edgePage({
        title: "Blocked",
        badge: "Blocked",
        tone: "danger",
        icon: SHIELD,
        heading: "Sorry, you have been blocked",
        lead: `You are unable to access ${edgeText(input.host, "this site")}.`,
        sections: [
            {
                heading: "Why have I been blocked?",
                body: edgeText(input.explanation, DEFAULT_EXPLANATION, 400)
            },
            {
                heading: "What can I do about it?",
                body: "If the site is yours, review its firewall rules. Otherwise contact the site owner and quote the reference below."
            }
        ],
        facts: [
            { label: "Reference ID", value: edgeText(input.reference, "unavailable", 64) },
            { label: "Your IP", value: edgeText(input.ip, "") }
        ],
        note: "Protected by Polaris"
    });
}
