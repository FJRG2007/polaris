/**
 * Access rules page (/account/access): the account's own rules - who may sign in
 * to it, from where and on what - and the saved address lists they are built out
 * of. The same lists are offered when scoping an API key, so an allowlist is
 * written once.
 */

import { accountRuleGroupIds } from "@polaris/core";
import { getTranslations } from "@/lib/i18n/request";
import { Messages } from "@/components/i18n/messages";
import { listAccessGroups, resolveEnforcedRules } from "@polaris/auth";
import { listAccountRules, reputationAvailable } from "@/lib/account-rules";
import { clientIp } from "@/lib/request-context";
import { requireUser } from "@/lib/session";
import { AccessView } from "./access-view";

export const dynamic = "force-dynamic";

export default async function AccessPage() {
    const user = await requireUser();
    const t = await getTranslations("account");
    const [rules, groups, ip, enforced, reputation] = await Promise.all([
        listAccountRules(user.id),
        listAccessGroups(user.id),
        clientIp(),
        resolveEnforcedRules(user.id),
        reputationAvailable()
    ]);

    return (
        <div className="mx-auto flex max-w-4xl flex-col gap-4">
            <div>
                <h1 className="text-[1.0625rem] font-semibold tracking-tight">{t("access.page.title")}</h1>
                <p className="text-sm text-muted-foreground">{t("access.page.intro")}</p>
            </div>
            {/* The rule list, its pages and the condition builder are the firewall's,
                and speak its words for what they share with it. */}
            <Messages namespaces={["firewall", "components"]}>
                <AccessView
                    groups={groups}
                    rules={rules}
                    signInGroupIds={accountRuleGroupIds(rules)}
                    reputation={reputation}
                    currentIp={ip ?? null}
                    enforced={enforced}
                />
            </Messages>
        </div>
    );
}
