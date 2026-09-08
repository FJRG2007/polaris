/**
 * Which sites to ask for a sender's mark, and in which order.
 *
 * Almost nobody sends from the domain their logo is on. Apple's receipts come
 * from `email.apple.com`, a shop's from `mail.shopify.com`, a bank's from
 * `notifications.<bank>.com` - and none of those subdomains has a favicon,
 * because nothing is served from them at all. Asking only the exact host is why
 * a mailbox full of household names showed initials.
 *
 * So the host is tried, then what it belongs to, then that domain's `www`. What
 * it belongs to is the awkward part: `apple.com` from `email.apple.com` is two
 * labels, and `bbc.co.uk` from `mail.bbc.co.uk` is three - the answer depends on
 * a list of public suffixes that is thousands of entries long and changes every
 * month, and shipping a copy of it here to fetch a favicon would be absurd.
 *
 * The compromise is stated rather than hidden: the well-known two-part suffixes
 * are listed, and everything else is treated as one label. Getting it wrong
 * costs one request that answers 404 or a mark that belongs to somebody else's
 * site - so the walk stops at three candidates, and never asks a bare public
 * suffix like `co.uk`, which is the one wrong answer that would be somebody
 * else's logo on every British sender in the list.
 *
 * The `www` is not redundant. A domain whose real site lives on `www` commonly
 * answers its bare form with a marketing page that has no 404 at all: LinkedIn
 * serves `linkedin.com/favicon.ico` as HTML with a 200, so the exact host looked
 * like it had a mark and the mark was a web page. Asking `www.linkedin.com`
 * afterwards is what puts their logo in the list.
 */

/**
 * The second-level suffixes worth knowing, by their top level.
 *
 * Not the whole list - that is the point. These are the ones a mailbox actually
 * meets: the country registries that put everybody under `co`, `com`, `net`,
 * `org`, `edu`, `gov` or `ac`.
 */
const SECOND_LEVEL = new Set([
    "co",
    "com",
    "net",
    "org",
    "edu",
    "ac",
    "gov",
    "mil",
    "or",
    "ne",
    "in",
    "gob"
]);

/** Country top levels, which are the only ones a second-level suffix sits
 *  under. A two-letter top level is a country by definition, and `.com.com` is
 *  not a thing. */
function isCountry(label: string): boolean {
    return label.length === 2;
}

/**
 * The domain a mark would actually be published on, or null when the host is
 * already it.
 *
 * `email.apple.com` -> `apple.com`. `mail.bbc.co.uk` -> `bbc.co.uk`. `apple.com`
 * and `bbc.co.uk` themselves -> null, because there is nothing above them worth
 * asking: the next step up is a public suffix, and whatever a registry serves on
 * its own front page is not this sender's logo.
 */
export function baseDomain(host: string): string | null {
    const labels = host.trim().toLowerCase().split(".").filter(Boolean);
    if (labels.length < 3) return null;

    const top = labels.at(-1) ?? "";
    const second = labels.at(-2) ?? "";
    const keep = isCountry(top) && SECOND_LEVEL.has(second) ? 3 : 2;
    if (labels.length <= keep) return null;
    return labels.slice(-keep).join(".");
}

/** Every site worth asking for one sender's mark, best first and never more than
 *  three: each one is a request to somebody else's server, and a fourth would be
 *  asking a registry for a logo. */
export function markDomains(host: string): string[] {
    const cleaned = host.trim().toLowerCase();
    if (!cleaned.includes(".")) return [];
    const base = baseDomain(cleaned);
    const canonical = base ?? cleaned;
    // A Set because the two rules meet on a host that is already a `www`:
    // `www.example.com` belongs to `example.com`, whose `www` is where it
    // started.
    const hosts = new Set([cleaned, canonical, `www.${canonical}`]);
    return [...hosts];
}
