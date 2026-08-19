/**
 * The GitHub token a run works with.
 *
 * The runtime does not get a long-lived credential. It presents GitHub's own OIDC
 * assertion, which names the repository its job belongs to, and gets back an
 * installation token scoped to that repository and nothing else. The App's private
 * key never leaves this instance.
 *
 * The `repos` query parameter is the runtime asking for a token that also reaches
 * other repositories, which is a cross-repository feature Polaris does not offer.
 * It is deliberately ignored rather than honoured: the token is minted for the one
 * repository the assertion proves, so a run cannot widen its own reach by asking.
 */

import { authenticateRun } from "@/lib/agents/agent-auth";
import { githubAppInstallationToken } from "@/lib/github-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
    const caller = await authenticateRun(request.headers);
    if (!caller) return Response.json({ error: "not a recognized run" }, { status: 401 });

    const owner = caller.repoFullName.split("/")[0] ?? "";
    const token = await githubAppInstallationToken(owner).catch(() => null);
    if (!token) {
        return Response.json(
            {
                error: `Polaris has no GitHub App installation it can use for ${owner}. An administrator connects one under Integrations.`
            },
            { status: 403 }
        );
    }

    return Response.json({ token }, { headers: { "cache-control": "no-store" } });
}
