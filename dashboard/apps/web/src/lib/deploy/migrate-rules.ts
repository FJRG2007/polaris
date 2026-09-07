/**
 * What travels when a service moves, and what stays behind.
 *
 * Pure, and apart from the move itself, because these three decisions are the
 * ones with a wrong answer that nobody notices until a build fails in a
 * fortnight: a Polaris variable sent to Vercel, a provider's secret written into
 * a database in the clear, or a repository read out of a shape that did not have
 * one.
 */

/**
 * Variables Polaris sets for its own containers.
 *
 * Left behind rather than carried, because a value naming a Polaris server, a
 * Polaris port or a Polaris collector is at best noise on somebody else's build
 * and at worst a wrong answer that takes an afternoon to find.
 */
const OURS = /^(POLARIS_|OTEL_)/;

/** What is worth carrying, out of whatever was read at either end. */
export function carriable(values: Readonly<Record<string, string>>): Record<string, string> {
    const kept: Record<string, string> = {};
    for (const [key, value] of Object.entries(values)) {
        if (!key.trim() || OURS.test(key)) continue;
        kept[key] = value;
    }
    return kept;
}

/**
 * Whether a variable is one anybody was ever meant to see.
 *
 * Everything arriving from a provider is treated as a secret, because it was one
 * there and nothing here can tell an API key from a feature flag by looking. The
 * exception is the prefixes every front-end framework uses to mean "this is
 * compiled into the browser bundle": those are public by definition, and storing
 * them masked would be theatre - it would hide from the operator a value that is
 * already in the page source of the site they just deployed.
 */
export function isPublicKey(key: string): boolean {
    return /^(NEXT_PUBLIC_|VITE_|PUBLIC_|REACT_APP_|NUXT_PUBLIC_|EXPO_PUBLIC_)/.test(key);
}

/**
 * The repository a Polaris service is built from, out of the JSON it is stored
 * as.
 *
 * A service built from an image or a plain Dockerfile has none, and empty is the
 * honest answer: the screen then says there is nothing for a provider to build,
 * rather than offering a move that would produce an empty project at the far end.
 */
export function repoFromSourceConfig(sourceConfig: string): { repoUrl: string; branch: string } {
    try {
        const parsed = JSON.parse(sourceConfig) as unknown;
        if (!parsed || typeof parsed !== "object") return { repoUrl: "", branch: "" };
        const source = parsed as Record<string, unknown>;
        return {
            repoUrl: typeof source.repoUrl === "string" ? source.repoUrl : "",
            branch: typeof source.branch === "string" ? source.branch : ""
        };
    } catch {
        return { repoUrl: "", branch: "" };
    }
}
