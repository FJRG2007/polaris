/**
 * A service's stored source, safe to hand to somebody who is not configuring it.
 *
 * A repository URL can carry a token in its userinfo - it is how a private
 * repository is cloned without a GitHub connection - and that token must not
 * travel with a template, reach a read-only CI key, or end up in a model's
 * context through an MCP tool. Everything that shows a service's source outside
 * its own settings goes through here.
 */

/** The source config, parsed, with any credentials in `repoUrl` taken out. An
 *  unreadable config is an empty one. */
export function redactSource(raw: string): Record<string, unknown> {
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return {};
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const source = parsed as Record<string, unknown>;
    if (typeof source.repoUrl === "string") {
        try {
            const url = new URL(source.repoUrl);
            url.username = "";
            url.password = "";
            source.repoUrl = url.toString();
        } catch {
            // Not a URL (an SSH remote); nothing to strip from it.
        }
    }
    return source;
}
