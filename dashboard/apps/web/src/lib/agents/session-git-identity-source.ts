/**
 * The git identity a session's agent commits as, read from what Polaris holds
 * about the person: their linked GitHub account first (the one for the
 * repository's owner when they linked several), their Polaris account second.
 * See `session-git-identity.ts`.
 */

import { prisma } from "@polaris/db";
import { appBaseUrl } from "@/lib/domain-service";
import { publicHostname } from "@/lib/domain-edge";
import { listConnections } from "@/lib/connections/store";
import { githubCredentialsForUser } from "@/lib/github-access";
import { readGithubAccount, type GithubAccount } from "@/lib/github-service";
import { identityFromGithub, identityFromUser, type GitIdentity } from "./session-git-identity";

/** How long a boot waits on GitHub for the display name before settling for
 *  what the connection stored. */
const LIVE_READ_MS = 3000;

async function liveAccount(token: string): Promise<GithubAccount | null> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), LIVE_READ_MS);
    });
    try {
        return await Promise.race([readGithubAccount(token).catch(() => null), timeout]);
    } finally {
        clearTimeout(timer);
    }
}

/**
 * Null only when the person has neither a GitHub link with an account id nor a
 * usable address on their Polaris account; the boot then sets nothing and the
 * machine's own configuration, if any, stands.
 */
export async function gitIdentityFor(ownerId: string | null, repoFullName: string): Promise<GitIdentity | null> {
    if (!ownerId) return null;
    const owner = repoFullName.split("/")[0]?.toLowerCase() ?? "";
    // A typed name carries no account id to build an address from.
    const links = (await listConnections(ownerId, "github").catch(() => [])).filter(
        (link) => link.method !== "manual"
    );
    const link = (owner && links.find((entry) => entry.label.toLowerCase() === owner)) || links[0];
    if (link) {
        const credential = (await githubCredentialsForUser(ownerId).catch(() => [])).find(
            (entry) => entry.connectionId === link.id
        );
        const live = credential ? await liveAccount(credential.token) : null;
        const identity =
            (live && identityFromGithub(live)) || identityFromGithub({ id: link.accountId, login: link.label });
        if (identity) return identity;
    }
    const user = await prisma.user
        .findUnique({ where: { id: ownerId }, select: { id: true, name: true } })
        .catch(() => null);
    // The instance's own public hostname, or none: never a guessed domain.
    const host = await appBaseUrl()
        .then((url) => publicHostname(url))
        .catch(() => null);
    return identityFromUser(user, host);
}
