import { log } from "./cli.ts";

/**
 * Where the runtime reaches its control plane, and how its paths map onto it.
 *
 * There is no hosted service behind this runtime. The control plane is the
 * Polaris instance that dispatched the run, so `POLARIS_API_URL` is required and
 * has no default: a missing one is a broken dispatch, and guessing an address
 * would send a run's credentials somewhere nobody chose.
 *
 * Every path the runtime asks for is written `/api/<thing>`; `apiPath` re-roots
 * those under `/api/agents` so they land in the dashboard's own namespace
 * without any call site having to know about it.
 */

/** Where the dashboard mounts this runtime's control-plane routes. */
const API_ROOT = "/api/agents";

function isLocalUrl(url: URL): boolean {
    return url.hostname === "localhost" || url.hostname === "127.0.0.1";
}

/**
 * The instance origin, validated.
 *
 * Plain HTTP is refused off localhost: the run's installation token, provider
 * keys and repository contents all cross this connection, and a LAN-only
 * instance still has a hostname a certificate can be issued for.
 */
export function getApiUrl(): string {
    const raw = process.env.POLARIS_API_URL;
    if (!raw) {
        throw new Error(
            "POLARIS_API_URL is not set. It names the Polaris instance that dispatched this run."
        );
    }

    const parsed = new URL(raw);
    if (parsed.protocol !== "https:" && !isLocalUrl(parsed)) {
        throw new Error(`POLARIS_API_URL must use https:// (got ${parsed.protocol}).`);
    }

    log.debug(`resolved POLARIS_API_URL: ${raw}`);
    return raw;
}

/**
 * Absolute URL for one of the runtime's control-plane paths.
 *
 * Built by concatenation rather than `new URL(path, base)`, which would discard
 * any path already on the base and drop every request out of `API_ROOT`.
 */
export function apiUrlFor(path: string): URL {
    const base = getApiUrl().replace(/\/+$/, "");
    const rooted = path.startsWith("/api/") ? `${API_ROOT}${path.slice(4)}` : path;
    return new URL(`${base}${rooted.startsWith("/") ? "" : "/"}${rooted}`);
}

/**
 * The instance origin, or null when it is not configured.
 *
 * Separate from getApiUrl because the two callers want opposite things from a
 * missing address: a request cannot proceed without one and should say so, while
 * the copy below is mostly written BY failure handlers. An error renderer that
 * throws replaces "no API key found" with "POLARIS_API_URL is not set", which is
 * the wrong problem and hides the real one.
 */
function instanceOrigin(): string | null {
    try {
        return getApiUrl().replace(/\/+$/, "");
    } catch {
        return null;
    }
}

/**
 * A markdown link to the Agents app, or the bare label when this run has no
 * instance address to point at. Naming a repository deep-links to its settings.
 */
export function settingsLink(label: string, owner?: string, repo?: string): string {
    const origin = instanceOrigin();
    if (!origin) return label;
    const base = `${origin}/apps/agents`;
    const url = owner
        ? `${base}/repos?repo=${encodeURIComponent(repo ? `${owner}/${repo}` : owner)}`
        : base;
    return `[${label}](${url})`;
}

/**
 * True when the control plane is a dashboard running on the developer's own box.
 * Gates dev-only affordances whose server side is gated the same way, so a
 * production instance never honours them however the runtime is configured.
 */
export function isLocalApiUrl(): boolean {
    try {
        return isLocalUrl(new URL(getApiUrl()));
    } catch {
        return false;
    }
}
