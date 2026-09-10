/**
 * Which mail domains the operator's Cloudflare token may be used for.
 *
 * The token reaches every zone on the operator's account, and a domain typed on
 * a mail server proves nothing about who holds it. So the rule is the one the DNS
 * record editor draws between its two scopes (`lib/dns/zone-records`): whoever
 * runs this Polaris may publish in any zone the token reaches, and anybody else
 * only at or under a domain they - or the organization the server is on - have
 * verified under Domains. Everybody else publishes the records by hand.
 */

import type { DomainOwner } from "@/lib/owner-domains";
import { provenDomainOf } from "@/lib/dns/zone-records";
import { MailServerAccessError, type MailServerActor } from "./access";
import { resolveZoneForHostname } from "@/lib/integrations/cloudflare-api";
import { loadCloudflareToken } from "@/lib/integrations/cloudflare-account-service";

function ownersFor(actor: MailServerActor, orgId: string | null): DomainOwner[] {
    return [
        { kind: "user", id: actor.id },
        ...(orgId ? [{ kind: "org" as const, id: orgId }] : [])
    ];
}

/**
 * Where the token may write for this caller: null for the whole zone, or the
 * verified domain every record has to be at or under. Refuses a caller with no
 * standing over the domain at all.
 */
export async function publishWithin(
    actor: MailServerActor,
    orgId: string | null,
    domain: string
): Promise<string | null> {
    if (actor.isAdmin) return null;
    const proven = await provenDomainOf(domain, ownersFor(actor, orgId));
    if (proven) return proven;
    throw new MailServerAccessError(
        `Publishing from here needs ${domain} verified under Domains. Until then, add the records listed under it at your DNS host.`
    );
}

/**
 * Refuse a mail domain in a zone on the operator's Cloudflare account that the
 * caller has not verified: it is the operator's domain, not theirs to receive
 * mail for. A domain hosted anywhere else is the caller's to publish by hand, and
 * a lookup that fails refuses nothing - without the token nothing here can write
 * to the zone anyway.
 */
export async function requireMailDomainStanding(
    actor: MailServerActor,
    orgId: string | null,
    domain: string
): Promise<void> {
    if (actor.isAdmin) return;
    if (await provenDomainOf(domain, ownersFor(actor, orgId))) return;
    const token = await loadCloudflareToken().catch(() => null);
    if (!token) return;
    const onAccount = await resolveZoneForHostname(token, domain).then(
        () => true,
        () => false
    );
    if (onAccount) {
        throw new MailServerAccessError(
            `${domain} is on this Polaris's own DNS account. Verify it under Domains, then add it here.`
        );
    }
}
