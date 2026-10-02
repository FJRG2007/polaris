/**
 * Your own domains, for your own deployed services.
 *
 * Nothing here touches the address Polaris itself is reached on - that belongs to
 * whoever runs the instance and lives under Management. This is one account
 * saying "I own example.com", proving it, and then being offered hostnames under
 * it when it deploys something.
 */

import { getTranslations } from "@/lib/i18n/request";
import { requireUser } from "@/lib/session";
import { Messages } from "@/components/i18n/messages";
import { getPublicIp } from "@/lib/domain-service";
import { gradesFor } from "@/lib/domain-security/service";
import { OwnerDomainsView } from "@/components/owner-domains-view";
import { canAddOwnerDomain, instanceDomains, listOwnerDomains } from "@/lib/owner-domains";

export const dynamic = "force-dynamic";

export default async function AccountDomainsPage() {
    const user = await requireUser();
    const t = await getTranslations("account");
    const owner = { kind: "user", id: user.id } as const;

    const [domains, allowed, publicIp, reserved] = await Promise.all([
        listOwnerDomains(owner),
        canAddOwnerDomain(owner, user.isAdmin),
        getPublicIp(),
        instanceDomains()
    ]);
    // One query for every badge; the cards read their own details after paint.
    const grades = await gradesFor(domains.map((entry) => entry.domain));

    return (
        <div className="mx-auto flex w-full max-w-7xl flex-col gap-6">
            <div>
                <h1 className="text-[1.0625rem] font-semibold tracking-tight">{t("domains.page.title")}</h1>
                <p className="text-muted-foreground text-sm">{t("domains.page.intro")}</p>
            </div>
            <Messages namespaces={["dns", "domainSecurity"]}>
                <OwnerDomainsView
                    owner={{ kind: "user" }}
                    domains={domains}
                    canAdd={allowed.ok}
                    blockedReason={allowed.ok ? "" : allowed.reason}
                    publicIp={publicIp}
                    instanceDomains={reserved}
                    grades={grades}
                />
            </Messages>
        </div>
    );
}
