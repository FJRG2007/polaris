/**
 * What somebody typed, read as the address of a Polaris.
 *
 * Pure, and in a module of its own because two places need it and they run in
 * different worlds: the popup, to decide whether Continue can be pressed at all,
 * and the background worker, which is where the answer actually has to be right.
 * The popup's copy is so the button can say no early; the worker's is the one
 * that decides, because a caller is never where a decision is allowed to be final.
 *
 * `server.ts` is the background's own module - it holds storage and asks the
 * browser for permissions - so the parsing lives here instead of being imported
 * out of it into a popup that must touch neither.
 */

/**
 * Turn what somebody typed into an origin, or refuse it.
 *
 * People type `polaris.local`, `https://polaris.example.com/vault`, and their
 * address with a path on the end because that is what the browser showed them.
 * All three mean the same server. What is refused is anything that is not a URL
 * at all, so the failure happens here with a sentence rather than later as a
 * fetch nobody can explain.
 */
export function readOrigin(typed: string): string | null {
    const trimmed = typed.trim();
    if (trimmed === "") return null;
    // A scheme that is not the web's is refused rather than prefixed. Left to the
    // line below, `ftp://polaris.example.com` became `https://ftp://…`, which
    // parses: host `ftp`, the rest a path. It answered with an origin nobody
    // typed instead of saying no.
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) && !/^https?:\/\//i.test(trimmed)) return null;
    const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
    try {
        const url = new URL(withScheme);
        if (url.protocol !== "https:" && url.protocol !== "http:") return null;
        if (url.hostname === "") return null;
        return url.origin;
    } catch {
        return null;
    }
}

/**
 * Whether this is far enough along to be worth asking the browser about.
 *
 * `readOrigin` answers a different question. `a` is a URL the moment a scheme is
 * put in front of it, so it produced an origin and the button went live on the
 * first keystroke - and pressing it spent the one permission prompt a gesture is
 * good for on a host that cannot exist.
 *
 * So a name has to have a dot with something either side of it, or be `localhost`.
 * Deliberately not a list of valid endings: a self-hosted Polaris answers on
 * whatever its owner owns, including names no public suffix list has heard of,
 * and refusing those would be refusing the people this is built for. An address
 * with a port and nothing else - `192.168.1.4:8080` - passes on the dot rule
 * already, which is the intent.
 */
export function looksLikeAddress(typed: string): boolean {
    const origin = readOrigin(typed);
    if (!origin) return false;
    const { hostname } = new URL(origin);
    if (hostname === "localhost") return true;
    // A label each side of a dot, and no label empty: "a.b" is somebody's LAN
    // name and is fine, ".com" and "polaris." are not.
    return /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/i.test(
        hostname
    );
}
