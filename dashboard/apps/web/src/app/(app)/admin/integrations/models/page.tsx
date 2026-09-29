/**
 * The model providers agents run on. Their own screen rather than a category in
 * the marketplace: there are more of them than of everything else put together,
 * and connecting one is a different job from connecting a service - no accounts
 * to link, no permissions to grant, just a key and the order they are tried in.
 * Admin-only, because a key here is the whole deployment's.
 *
 * The same screen an account gets for its own keys, because it is the same job.
 * The deployment's keys were once one per provider with no name, no end date and
 * no second key, which made an administrator's credentials the only ones nobody
 * could keep a spare of.
 */

import Link from "next/link";
import type { ReactNode } from "react";
import { Card, CardBody } from "@polaris/ui";
import { requireAdmin } from "@/lib/session";
import { getTranslations } from "@/lib/i18n/request";
import { modelProviderRows } from "@/lib/agents/model-key-providers";
import { signinProviderRows } from "@/lib/agents/agent-signins";
import { ModelKeysView } from "@/components/model-keys/model-keys-view";
import { instanceKeysAreShared, INSTANCE, listAgentSignins, listProviderKeys } from "@/lib/agents/model-keys";
import {
    addInstanceModelKeyAction,
    deleteInstanceModelKeyAction,
    reorderInstanceModelKeysAction,
    updateInstanceModelKeyAction
} from "./actions";

export const dynamic = "force-dynamic";

export default async function ModelProvidersPage() {
    await requireAdmin();
    const t = await getTranslations("admin");
    // Two listings rather than one filtered afterwards: agent sign-ins share this
    // table and would otherwise appear in the provider list as a credential for a
    // provider that does not exist.
    const [keys, signins, shared] = await Promise.all([
        listProviderKeys(INSTANCE),
        listAgentSignins(INSTANCE),
        instanceKeysAreShared()
    ]);

    return (
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-4">
            <div>
                <h1 className="text-[1.0625rem] font-semibold tracking-tight">
                    {t("integrationsModels.title")}
                </h1>
                <p className="text-muted-foreground text-sm">{t("integrationsModels.intro")}</p>
            </div>
            <ModelKeysView
                providers={modelProviderRows()}
                keys={keys}
                actions={{
                    add: addInstanceModelKeyAction,
                    update: updateInstanceModelKeyAction,
                    remove: deleteInstanceModelKeyAction,
                    reorder: reorderInstanceModelKeysAction
                }}
                copy={{
                    title: t("integrationsModels.keys.title"),
                    hint: t("integrationsModels.keys.hint"),
                    empty: t("integrationsModels.keys.empty"),
                    adding: t("integrationsModels.keys.adding")
                }}
                footer={
                    <SharingCard
                        title={t("integrationsModels.sharing.title")}
                        body={t.rich(
                            shared ? "integrationsModels.sharing.shared" : "integrationsModels.sharing.private",
                            {
                                link: (chunks) => (
                                    <Link key="link" href="/admin/agents" className="text-primary hover:underline">
                                        {chunks}
                                    </Link>
                                )
                            }
                        )}
                    />
                }
            />

            {/* The deployment's own agent accounts, in the same table and for the
                same reason the provider keys are in one: everything about them is
                a key - named, reordered, renamed, given an end date, shown with
                its last use - and a card of its own would have had to grow every
                one of those separately and still look like a different feature.
                No assisted sign-in here: an administrator would be asked to
                authorise a subscription that is not theirs, in their own browser. */}
            <ModelKeysView
                providers={signinProviderRows()}
                keys={signins}
                actions={{
                    add: addInstanceModelKeyAction,
                    update: updateInstanceModelKeyAction,
                    remove: deleteInstanceModelKeyAction,
                    reorder: reorderInstanceModelKeysAction
                }}
                copy={{
                    title: t("integrationsModels.accounts.title"),
                    action: t("integrationsModels.accounts.action"),
                    hint: t("integrationsModels.accounts.hint"),
                    empty: t("integrationsModels.accounts.empty"),
                    adding: t("integrationsModels.accounts.adding")
                }}
            />
            <p className="text-muted-foreground text-sm">
                {t.rich("integrationsModels.elsewhere", {
                    link: (chunks) => (
                        <Link key="link" href="/admin/integrations" className="text-primary hover:underline">
                            {chunks}
                        </Link>
                    )
                })}
            </p>
        </div>
    );
}

/** Who actually spends these. The switch itself is one of the agent defaults, so
 *  it is named here rather than offered twice. Its words are drawn by the page,
 *  which has the translator. */
function SharingCard({ title, body }: { title: string; body: ReactNode }) {
    return (
        <Card>
            <CardBody className="flex flex-col gap-1">
                <h2 className="text-sm font-medium">{title}</h2>
                <p className="text-muted-foreground text-xs">{body}</p>
            </CardBody>
        </Card>
    );
}
