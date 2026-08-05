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

const ENTITIES: Record<string, string> = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
};

/** The default "why", which describes the class of blocks rather than the rule. */
const DEFAULT_EXPLANATION =
    "This site runs a firewall. Something about this request matched a rule that blocks it, either where it came from or what it carried.";

/**
 * Prepare one value for the page. Most of what is shown arrives in a request header,
 * which is attacker-controlled in both what it contains and how much of it there is - so
 * everything is capped and escaped rather than interpolated.
 */
function text(value: string | null | undefined, fallback: string, limit = 120): string {
    const raw = (value ?? "").trim().slice(0, limit);
    if (raw.length === 0) return fallback;
    return raw.replace(/[&<>"']/g, (char) => ENTITIES[char] ?? char);
}

/** Render the block page for one refused request. */
export function wafBlockPage(input: WafBlockPageInput): string {
    const host = text(input.host, "this site");
    const ip = text(input.ip, "");
    const why = text(input.explanation, DEFAULT_EXPLANATION, 400);
    const reference = text(input.reference, "unavailable", 64);
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Blocked</title>
<style>
:root {
    color-scheme: dark light;
    --bg: 250 22% 6%;
    --card: 250 16% 10%;
    --fg: 250 16% 93%;
    --muted: 250 9% 62%;
    --border: 250 13% 17%;
    --danger: 358 72% 58%;
}
@media (prefers-color-scheme: light) {
    :root {
        --bg: 250 40% 98%;
        --card: 0 0% 100%;
        --fg: 250 24% 14%;
        --muted: 250 10% 40%;
        --border: 250 20% 89%;
        --danger: 358 66% 50%;
    }
}
*, *::before, *::after { box-sizing: border-box; }
body {
    margin: 0;
    min-height: 100vh;
    display: grid;
    place-items: center;
    padding: 2rem 1.25rem;
    background: hsl(var(--bg));
    color: hsl(var(--fg));
    font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    line-height: 1.55;
    -webkit-font-smoothing: antialiased;
}
main {
    width: 100%;
    max-width: 34rem;
    padding: 2rem;
    background: hsl(var(--card));
    border: 1px solid hsl(var(--border));
    border-radius: 0.75rem;
}
.badge {
    display: inline-flex;
    align-items: center;
    gap: 0.5rem;
    color: hsl(var(--danger));
    font-size: 0.75rem;
    font-weight: 600;
    letter-spacing: 0.06em;
    text-transform: uppercase;
}
h1 { margin: 1rem 0 0.5rem; font-size: 1.5rem; letter-spacing: -0.01em; }
h2 { margin: 0 0 0.25rem; font-size: 0.9375rem; }
p { margin: 0; color: hsl(var(--muted)); font-size: 0.9375rem; }
.lead { margin-bottom: 2rem; }
section { margin-bottom: 1.5rem; }
footer {
    display: flex;
    flex-wrap: wrap;
    gap: 0.375rem 1.5rem;
    padding-top: 1.25rem;
    border-top: 1px solid hsl(var(--border));
    color: hsl(var(--muted));
    font-size: 0.8125rem;
}
code {
    color: hsl(var(--fg));
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    word-break: break-all;
}
</style>
</head>
<body>
<main>
<span class="badge"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/><path d="M12 8v4"/><path d="M12 16h.01"/></svg>Blocked</span>
<h1>Sorry, you have been blocked</h1>
<p class="lead">You are unable to access ${host}.</p>
<section>
<h2>Why have I been blocked?</h2>
<p>${why}</p>
</section>
<section>
<h2>What can I do about it?</h2>
<p>If the site is yours, review its firewall rules. Otherwise contact the site owner and quote the reference below.</p>
</section>
<footer>
<span>Reference ID <code>${reference}</code></span>
${ip ? `<span>Your IP <code>${ip}</code></span>\n` : ""}<span>Protected by Polaris</span>
</footer>
</main>
</body>
</html>
`;
}
