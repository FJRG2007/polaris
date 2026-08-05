/**
 * The organization's own domains.
 *
 * The same screen an account gets, pointed at the organization instead - which is
 * the point: a company on a shared Polaris publishes on its own name without
 * being handed the instance's DNS settings, and nothing here can move the address
 * Polaris itself is reached on.
 */

import { getPublicIp } from "@/lib/domain-service";
import { requireOrgPage } from "@/lib/orgs/page-access";
import { OwnerDomainsView } from "@/components/owner-domains-view";
import { canAddOwnerDomain, listOwnerDomains } from "@/lib/owner-domains";

export const dynamic = "force-dynamic";

export default async function OrganizationDomainsPage({ params }: { params: Promise<{ slug: string }> }) {
    const { slug } = await params;
    const { org, user } = await requireOrgPage(slug, "domains.manage");
    const owner = { kind: "org", id: org.id } as const;

    const [domains, allowed, publicIp] = await Promise.all([
        listOwnerDomains(owner),
        canAddOwnerDomain(owner, user.isAdmin),
        getPublicIp()
    ]);

    return (
        <div className="flex flex-col gap-4">
            <div>
                <h2 className="text-base font-semibold">Domains</h2>
                <p className="text-muted-foreground text-sm">
                    Domains {org.name} owns, so its services answer on its own name rather than this
                    Polaris&rsquo;s.
                </p>
            </div>
            <OwnerDomainsView
                owner={{ kind: "org", orgId: org.id }}
                domains={domains}
                canAdd={allowed.ok}
                blockedReason={allowed.ok ? "" : allowed.reason}
                publicIp={publicIp}
            />
        </div>
    );
}
