/**
 * Whether this box can reach the internet at all.
 *
 * The question in front of every "your domain is not answering" alert. Polaris
 * probes its own address from inside the container, so a failure means one of two
 * completely different things: the domain really is down - DNS moved, the edge is
 * wedged, the ISP dropped the port forward - or Polaris has no way out and cannot
 * see anything, its own domain included.
 *
 * Told apart they are two different jobs for the operator. Confused, the second
 * one wears the first one's clothes: somebody is sent to check DNS records for a
 * domain that is fine, on a morning when the router is unplugged.
 *
 * So before an address is reported down, this asks something that does not go
 * down. Two of them, from different companies, because the point is to be
 * certain: one resolver being unreachable is a fact about that resolver.
 *
 * A plain HTTPS GET rather than a ping or a DNS query: ICMP is blocked on plenty
 * of networks and would report a false outage, and the DNS resolver inside a
 * container is not the network. What is being asked is "can this process open a
 * connection to the internet", and an HTTPS request is that question exactly.
 */

/**
 * What is asked, and why these.
 *
 * Both are anycast resolvers run by companies whose business is being reachable,
 * on addresses that have not changed in a decade. Addresses rather than names on
 * purpose: a name would make this a test of DNS as well, and a box with working
 * DNS and no route is the case that would then be reported wrongly.
 */
const LANDMARKS = ["https://1.1.1.1", "https://8.8.8.8"] as const;

/** How long one of them gets. Short: this runs in front of an alert somebody is
 *  waiting on, and a landmark that takes four seconds is a landmark that is
 *  telling us something anyway. */
const TIMEOUT_MS = 4000;

/** How long an answer is believed. The question is "is the line up", which does
 *  not change minute to minute, and every address in a sweep asks it. */
const CACHE_MS = 60_000;

let remembered: { at: number; online: boolean } | null = null;

/**
 * True when at least one landmark answered.
 *
 * Fails towards "online" only in the sense that a single unreachable landmark is
 * not an outage - both have to be silent. That is the conservative direction
 * here: claiming the internet is down when it is not would rewrite a real alert
 * into a wrong one, and the real alert is the one worth keeping.
 */
export async function hasInternet(now = Date.now()): Promise<boolean> {
    if (remembered && now - remembered.at < CACHE_MS) return remembered.online;

    const answers = await Promise.all(LANDMARKS.map((url) => reaches(url)));
    const online = answers.some(Boolean);
    remembered = { at: now, online };
    return online;
}

/**
 * The failures that mean "no route", as opposed to "there was something there".
 *
 * The distinction is the whole point of the function. A refused connection, a
 * name that will not resolve, a timeout: nothing answered. A certificate this
 * process does not like, a protocol error, an HTTP status: something answered,
 * which is all that was being asked.
 */
const NO_ROUTE = new Set([
    "ENOTFOUND",
    "EAI_AGAIN",
    "ECONNREFUSED",
    "ECONNRESET",
    "EHOSTUNREACH",
    "ENETUNREACH",
    "ETIMEDOUT",
    "EPIPE",
    "UND_ERR_CONNECT_TIMEOUT"
]);

async function reaches(url: string): Promise<boolean> {
    try {
        // Any answer at all is the answer. A 400 from a resolver that does not
        // serve pages still proves a connection reached it, which is the whole
        // question - so nothing about the response is read.
        await fetch(url, {
            method: "HEAD",
            signal: AbortSignal.timeout(TIMEOUT_MS),
            redirect: "manual"
        });
        return true;
    } catch (caught) {
        // A timeout is a route that did not carry, which counts as none.
        if (caught instanceof Error && (caught.name === "TimeoutError" || caught.name === "AbortError")) {
            return false;
        }
        const cause = (caught as { cause?: { code?: string } })?.cause;
        // Anything that is not a connection failure is a connection: a
        // certificate this process will not accept still crossed the network to
        // be rejected, and reporting the line as down over it would rewrite a
        // real alert into a wrong one.
        return !(typeof cause?.code === "string" && NO_ROUTE.has(cause.code));
    }
}

/** For the tests, and for an operator pressing "check again" rather than waiting
 *  out the minute. */
export function forgetInternetReach(): void {
    remembered = null;
}
