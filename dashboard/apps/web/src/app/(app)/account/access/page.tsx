/**
 * Access rules page (/account/access): where the account may be signed in from,
 * and the reusable groups those rules are built out of. The same groups are
 * offered when scoping an API key, so an allowlist is written once.
 */

import { getUserSecurity, listAccessGroups, resolveEnforcedRules } from "@polaris/auth";
import { clientIp } from "@/lib/request-context";
import { requireUser } from "@/lib/session";
import { AccessView } from "./access-view";

export const dynamic = "force-dynamic";

export default async function AccessPage() {
    const user = await requireUser();
    const [settings, groups, ip, enforced] = await Promise.all([
        getUserSecurity(user.id),
        listAccessGroups(user.id),
        clientIp(),
        resolveEnforcedRules(user.id)
    ]);

    return (
        <div className="mx-auto flex max-w-2xl flex-col gap-4">
            <div>
                <h1 className="text-[17px] font-semibold tracking-tight">Access rules</h1>
                <p className="text-sm text-muted-foreground">
                    Restrict where your account and your API keys may be used from.
                </p>
            </div>
            <AccessView
                groups={groups}
                currentIp={ip ?? null}
                enforced={enforced}
                signInRules={{
                    groupIds: settings.groupIds,
                    allowedCidrs: settings.allowedCidrs,
                    allowedCountries: settings.allowedCountries,
                    allowedContinents: settings.allowedContinents
                }}
            />
        </div>
    );
}
