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
import { Suspense, type ReactNode } from "react";
import { Card, CardBody } from "@polaris/ui";
import { requireAdmin } from "@/lib/session";
import { getTranslations } from "@/lib/i18n/request";
import { listCustomProviders } from "@/lib/integrations/provider-catalog";
import { AiProvidersPanel } from "@/components/model-keys/ai-providers-panel";
import { CardSkeleton } from "@/app/(app)/admin/region-skeletons";
import { CustomProvidersCard } from "./custom-providers-card";
import { INSTANCE_ACTIONS } from "./instance-actions";

export const dynamic = "force-dynamic";

export default async function ModelProvidersPage() {
    await requireAdmin();
    const t = await getTranslations("admin");
    // Both readings of the sharing note, so the region can show the one that is
    // true once it knows, without a translation of its own.
    const agentsLink = (chunks: ReactNode) => (
        <Link key="link" href="/admin/agents" className="text-primary hover:underline">
            {chunks}
        </Link>
    );
    const sharingTitle = t("integrationsModels.sharing.title");

    return (
        <div className="mx-auto flex w-full max-w-6xl flex-col gap-4">
            <div>
                <h1 className="text-[1.0625rem] font-semibold tracking-tight">
                    {t("integrationsModels.title")}
                </h1>
                <p className="text-muted-foreground text-sm">{t("integrationsModels.intro")}</p>
            </div>
            {/* The same panel an account gets under Polar's settings: the
                deployment's keys, plans, clouds and agent accounts are the
                defaults every account falls back to, and they are kept the
                same way. Streamed, so the heading paints before the read. */}
            <Suspense
                fallback={
                    <>
                        <CardSkeleton lines={4} />
                        <CardSkeleton lines={2} />
                    </>
                }
            >
                <AiProvidersPanel
                    owner={{
                        kind: "deployment",
                        sharedFooter: (
                            <SharingCard
                                title={sharingTitle}
                                body={t.rich("integrationsModels.sharing.shared", { link: agentsLink })}
                            />
                        ),
                        privateFooter: (
                            <SharingCard
                                title={sharingTitle}
                                body={t.rich("integrationsModels.sharing.private", { link: agentsLink })}
                            />
                        )
                    }}
                    actions={INSTANCE_ACTIONS}
                    copy={{
                        title: t("integrationsModels.keys.title"),
                        hint: t("integrationsModels.keys.hint"),
                        empty: t("integrationsModels.keys.empty"),
                        adding: t("integrationsModels.keys.adding")
                    }}
                    after={<CustomProviders />}
                />
            </Suspense>
            <p className="text-muted-foreground text-sm">
                {t.rich("integrationsModels.elsewhere", {
                    link: (chunks) => (
                        <Link
                            key="link"
                            href="/admin/integrations"
                            className="text-primary hover:underline"
                        >
                            {chunks}
                        </Link>
                    )
                })}
            </p>
        </div>
    );
}

/** The providers this deployment added by address, under the table. */
async function CustomProviders() {
    return <CustomProvidersCard initial={await listCustomProviders()} />;
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
