/**
 * Your own domains, for your own deployed services.
 *
 * Nothing here touches the address Polaris itself is reached on - that belongs to
 * whoever runs the instance and lives under Management. This is one account
 * saying "I own example.com", proving it, and then being offered hostnames under
 * it when it deploys something.
 */

import { requireUser } from "@/lib/session";
import { getPublicIp } from "@/lib/domain-service";
import { OwnerDomainsView } from "@/components/owner-domains-view";
import { canAddOwnerDomain, listOwnerDomains } from "@/lib/owner-domains";

export const dynamic = "force-dynamic";

export default async function AccountDomainsPage() {
    const user = await requireUser();
    const owner = { kind: "user", id: user.id } as const;

    const [domains, allowed, publicIp] = await Promise.all([
        listOwnerDomains(owner),
        canAddOwnerDomain(owner, user.isAdmin),
        getPublicIp()
    ]);

    return (
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-4">
            <div>
                <h1 className="text-[17px] font-semibold tracking-tight">Domains</h1>
                <p className="text-muted-foreground text-sm">
                    Domains you own, so what you deploy here answers on your own name instead of this Polaris&rsquo;s.
                </p>
            </div>
            <OwnerDomainsView
                owner={{ kind: "user" }}
                domains={domains}
                canAdd={allowed.ok}
                blockedReason={allowed.ok ? "" : allowed.reason}
                publicIp={publicIp}
            />
        </div>
    );
}
