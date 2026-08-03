/**
 * Which services a push should actually redeploy.
 *
 * One repository can hold several services - a monorepo with two sites, an API and a
 * worker, each its own service here. Without this, every one of them redeploys on every
 * push, so a typo in a README rebuilds five images and restarts five containers. Watch
 * paths are how Railway solves it and how Vercel's ignored build step is usually
 * written; the semantics below are Railway's, because they are the ones expressible as
 * a setting rather than a shell command.
 *
 * A pattern is a glob over repository-relative paths:
 *
 *   apps/web/**        everything under apps/web
 *   packages/ui/**     a shared package this service is built from
 *   *.json             a file at the repository root
 *   !**\/*.md          never on account of documentation
 *
 * A push deploys the service when at least one changed file is included and not
 * excluded. Excludes alone mean "everything except these". No patterns at all means
 * every push deploys, which is what a single-service repository wants and what every
 * service configured before this existed keeps doing.
 *
 * Deliberately a matcher of our own rather than a glob dependency: the syntax accepted
 * here is the syntax documented above and nothing more, and a matcher whose behaviour
 * is a library's release notes is a matcher nobody can predict from the settings page.
 */

/** One parsed pattern: its matcher and whether it excludes rather than includes. */
interface WatchPattern {
    readonly test: RegExp;
    readonly negated: boolean;
}

/** Parse the stored field (one pattern per line, blanks and `#` comments ignored). */
export function parseWatchPaths(raw: string | null | undefined): string[] {
    if (!raw) return [];
    return raw
        .split(/[\r\n]+/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0 && !line.startsWith("#"));
}

/**
 * Compile one glob to an anchored regular expression.
 *
 * `**` crosses directory separators, `*` and `?` do not, and everything else is
 * literal - so a pattern carrying a regex metacharacter matches that character rather
 * than doing something surprising with it.
 */
function compile(pattern: string): RegExp {
    let out = "";
    for (let i = 0; i < pattern.length; i += 1) {
        const char = pattern[i];
        if (char === "*") {
            if (pattern[i + 1] === "*") {
                // `**/` also matches zero directories, so `apps/**` covers `apps` itself
                // and `**/*.md` covers a README at the root.
                if (pattern[i + 2] === "/") {
                    out += "(?:.*/)?";
                    i += 2;
                } else {
                    out += ".*";
                    i += 1;
                }
            } else {
                out += "[^/]*";
            }
            continue;
        }
        if (char === "?") {
            out += "[^/]";
            continue;
        }
        out += char!.replace(/[.+^${}()|[\]\\]/, "\\$&");
    }
    return new RegExp(`^${out}$`);
}

function parsePatterns(patterns: readonly string[]): WatchPattern[] {
    return patterns.map((pattern) => {
        const negated = pattern.startsWith("!");
        const body = negated ? pattern.slice(1) : pattern;
        // A bare directory means everything under it. Writing `apps/web` and getting
        // nothing because the changed file was `apps/web/page.tsx` is the mistake this
        // saves everyone from making once.
        const expanded = body.endsWith("/") ? `${body}**` : body;
        return { test: compile(expanded), negated };
    });
}

/** True when one path is included by the patterns (and not excluded). */
function pathMatches(path: string, patterns: readonly WatchPattern[]): boolean {
    const includes = patterns.filter((pattern) => !pattern.negated);
    if (patterns.some((pattern) => pattern.negated && pattern.test.test(path))) return false;
    // Excludes on their own read as "everything except these", so a path that survived
    // the exclusions above is a match when nothing was explicitly included.
    if (includes.length === 0) return true;
    return includes.some((pattern) => pattern.test.test(path));
}

/**
 * Whether a push touching `changed` should deploy a service watching `patterns`.
 *
 * `changed` being empty deploys: an empty list means the changed files could not be
 * determined (a push too large for the webhook payload, an API that would not answer),
 * not that nothing changed. Erring towards a redundant deploy is the right way round -
 * the other way silently stops deploying and looks exactly like a broken webhook.
 */
export function shouldDeployForPaths(changed: readonly string[], patterns: readonly string[]): boolean {
    if (patterns.length === 0) return true;
    if (changed.length === 0) return true;
    const parsed = parsePatterns(patterns);
    return changed.some((path) => pathMatches(path, parsed));
}
