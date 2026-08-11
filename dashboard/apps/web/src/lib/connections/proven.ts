/**
 * Whether an outside service has ever completed a round trip on this deployment.
 *
 * Credentials that parse are not a service that works, and the gap between the two
 * is where every one of these setups fails. Google is the clearest case: an id and
 * a secret that are a genuine pair, a redirect URI registered exactly right, and
 * it still refuses everybody with `access_denied`, because the client is in
 * Testing and only the accounts listed there may authorize. Nothing about that is
 * visible from the credentials, and nothing about it can be asked of Google from
 * this server - it is decided per person, after they have signed in, inside a
 * console this deployment cannot read.
 *
 * So the check is the thing itself. One authorization has to have completed here,
 * end to end, before the service is offered to anybody: until then only an
 * administrator can start the trip - they are the one who can fix what it hits -
 * and everybody else is told it is not ready rather than sent to an error page
 * with somebody else's console in it.
 *
 * A deployment where people have already linked accounts is proven by those
 * accounts. Requiring a fresh authorization from an operator who set this up
 * months ago would take a working service away to prove something it has been
 * demonstrating all along.
 */

import { prisma } from "@polaris/db";
import { getIntegrationState, upsertIntegration } from "@/lib/integration-service";

/** Stored on the integration's own config rather than in a Setting, so forgetting
 *  the application forgets this with it - a new client is a new thing to prove. */
const PROVEN_AT = "provenAt";

export async function connectionProven(provider: string): Promise<boolean> {
    const state = await getIntegrationState(provider);
    if (typeof state?.config[PROVEN_AT] === "string") return true;
    return (await everLinked(provider)) !== null;
}

/** Record that one has completed. Written once: what it answers is "has this ever
 *  worked", and a later failure is not evidence that it never did. */
export async function markConnectionProven(provider: string): Promise<void> {
    const state = await getIntegrationState(provider);
    // No row means no application, so nothing reached the provider and there is
    // nothing to record it against.
    if (!state || typeof state.config[PROVEN_AT] === "string") return;
    await upsertIntegration(provider, {
        config: { ...state.config, [PROVEN_AT]: new Date().toISOString() }
    });
}

/** An account somebody authorized here, which is the same proof by another route.
 *  Only an authorized one: a token somebody pasted proves nothing about the
 *  operator's application. */
function everLinked(provider: string): Promise<{ id: string } | null> {
    return prisma.userConnection.findFirst({ where: { provider, method: "oauth" }, select: { id: true } });
}
