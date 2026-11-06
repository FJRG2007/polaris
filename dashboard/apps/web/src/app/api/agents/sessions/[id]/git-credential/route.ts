/**
 * POST /api/agents/sessions/:id/git-credential - a session's git asking for a token.
 *
 * Called by the credential helper Polaris installs in a session's checkout
 * (`gitCredentialScript`), never by a person. The agent holds no GitHub token of
 * its own; each time its git needs one, this mints a token from the GitHub App
 * installation on the repository's owner, scoped to that one repository and to
 * reading and writing its contents.
 *
 * Authorised by the session's own reporting token, which has to name the same
 * session as the URL, and which a finished session no longer has. The answer is
 * in git's credential format, because git is the only reader.
 */

import * as scoping from "@/lib/github-installation-scope";
import { githubAppInstallationToken } from "@/lib/github-service";
import { sessionForToken, sessionRepository } from "@/lib/agents/session-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function bearer(request: Request): string {
    const header = request.headers.get("authorization") ?? "";
    const [scheme, ...rest] = header.trim().split(/\s+/);
    return scheme?.toLowerCase() === "bearer" ? rest.join("") : "";
}

/** Read by git, not shown to a person: an empty body is git's "no credential". */
function refused(status: number): Response {
    return new Response("", { status, headers: { "cache-control": "no-store" } });
}

export async function POST(
    request: Request,
    { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
    const { id } = await params;
    const session = await sessionForToken(bearer(request));
    if (!session || session.id !== id) return refused(401);

    const repository = await sessionRepository(id);
    const scoped = repository
        ? scoping.repositoryScope(repository, scoping.AGENT_GIT_PERMISSIONS)
        : null;
    if (!scoped) return refused(404);

    const token = await githubAppInstallationToken(scoped.owner, scoped.scope).catch((error) => {
        console.error(`[agent-session] ${id}: no scoped token for ${repository}:`, error);
        return null;
    });
    if (!token) return refused(403);

    return new Response(scoping.gitCredentialAnswer(token), {
        headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" }
    });
}
