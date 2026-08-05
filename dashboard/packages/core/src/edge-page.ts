/**
 * The shell every page the edge serves on its own account is built from.
 *
 * There are two of them and they answer opposite questions - "the firewall refused
 * you" and "nothing is deployed on this name" - but they are the same object to the
 * person reading: a page from the edge, about the request they just made, on a site
 * whose own design they never reached. Two documents would drift in wording, in
 * markup and in what they leak, so the badge, the reasons and the footer facts are
 * the only things a caller supplies.
 *
 * Everything on these pages arrives in a request header, which is attacker-controlled
 * in both what it contains and how much of it there is. `edgeText` is what makes a
 * value safe to place; the shell interpolates what it is given without escaping it a
 * second time, so a caller that skips it has written the hole itself. That is why
 * every field on `EdgePageInput` is documented as already-prepared text.
 */

const ENTITIES: Record<string, string> = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
};

/**
 * Prepare one value for a page: capped, escaped, and replaced by `fallback` when
 * there is nothing left. The cap is the point as much as the escaping - a header can
 * be kilobytes long, and a page is not a place to render one.
 */
export function edgeText(value: string | null | undefined, fallback: string, limit = 120): string {
    const raw = (value ?? "").trim().slice(0, limit);
    if (raw.length === 0) return fallback;
    return raw.replace(/[&<>"']/g, (char) => ENTITIES[char] ?? char);
}

/** One "why is this happening" block. Both strings are already prepared text. */
export interface EdgePageSection {
    readonly heading: string;
    readonly body: string;
}

/** One footer fact, rendered as a label and a monospace value. */
export interface EdgePageFact {
    readonly label: string;
    /** Already prepared text. Omitted from the footer when empty. */
    readonly value: string;
}

/** What the shell renders. Every string is already prepared text (see `edgeText`). */
export interface EdgePageInput {
    /** Browser tab title. */
    readonly title: string;
    /** The uppercase chip above the heading. */
    readonly badge: string;
    /** Red for a refusal, grey for a name with nothing behind it. */
    readonly tone: "danger" | "muted";
    /** The chip's icon, as the contents of a 24x24 stroked `<svg>`. */
    readonly icon: string;
    readonly heading: string;
    readonly lead: string;
    readonly sections: readonly EdgePageSection[];
    readonly facts: readonly EdgePageFact[];
    /** The last footer item, which carries no value of its own. */
    readonly note: string;
}

/** Render one edge page. */
export function edgePage(input: EdgePageInput): string {
    const sections = input.sections
        .map((section) => `<section>\n<h2>${section.heading}</h2>\n<p>${section.body}</p>\n</section>`)
        .join("\n");
    const facts = input.facts
        .filter((fact) => fact.value !== "")
        .map((fact) => `<span>${fact.label} <code>${fact.value}</code></span>`)
        .join("\n");
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${input.title}</title>
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
    color: hsl(var(--${input.tone}));
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
<span class="badge"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${input.icon}</svg>${input.badge}</span>
<h1>${input.heading}</h1>
<p class="lead">${input.lead}</p>
${sections}
<footer>
${facts}
<span>${input.note}</span>
</footer>
</main>
</body>
</html>
`;
}
