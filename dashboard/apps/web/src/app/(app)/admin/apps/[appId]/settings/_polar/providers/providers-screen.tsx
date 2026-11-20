/**
 * Polar's AI providers for the whole deployment (/admin/apps/polar/settings/providers):
 * the keys, plans, clouds and agent accounts every account falls back to, the
 * providers added by address, whether accounts may run on the deployment's keys,
 * and the model catalogue those keys are picked from. Everything here is Polar's
 * AI - its chats, Polar Code and the code review bot all run on these keys - so it
 * is kept with Polar's settings rather than with the services under Integrations.
 * A person's own keys stay under Polar > Settings > AI providers.
 *
 * The same panel an account gets for its own keys, because it is the same job.
 */

import Link from "next/link";
import { Suspense } from "react";
import { prisma } from "@polaris/db";
import { ArrowLeft } from "lucide-react";
import { PageHeader } from "@polaris/ui";
import { getTranslations } from "@/lib/i18n/request";
import { Messages } from "@/components/i18n/messages";
import { INSTANCE_ACTIONS } from "./instance-actions";
import { appSettingsPath } from "@/lib/apps/app-settings";
import { CatalogCard, KeySharingCard } from "../catalog-card";
import { CustomProvidersCard } from "./custom-providers-card";
import { catalogRefreshedAt } from "@/lib/agents/model-catalog";
import { CardSkeleton } from "@/app/(app)/admin/region-skeletons";
import { AiProvidersPanel } from "@/components/model-keys/ai-providers-panel";
import { listCustomProviders, providerIndexState } from "@/lib/integrations/provider-catalog";

/** Drawn by the settings screen page, which has already checked for an administrator. */
export async function PolarProvidersScreen() {
    const [t, marketplace] = await Promise.all([getTranslations("polar"), getTranslations("marketplace")]);

    return (
        <Messages namespaces={["polar"]}>
            <div className="mx-auto flex w-full min-w-0 max-w-6xl flex-col gap-4">
                <Link
                    data-swipe-back
                    href={appSettingsPath("polar")}
                    className="text-muted-foreground hover:text-foreground inline-flex w-fit items-center gap-1 text-sm"
                >
                    <ArrowLeft className="size-4" />
                    {marketplace("detail.settings")}
                </Link>
                <PageHeader title={t("admin.providers.title")} description={t("admin.providers.intro")} />
                {/* Streamed, so the heading paints before the read. */}
                <Suspense
                    fallback={
                        <>
                            <CardSkeleton lines={4} />
                            <CardSkeleton lines={2} />
                        </>
                    }
                >
                    <AiProvidersPanel
                        owner={{ kind: "deployment", footer: (shared) => <KeySharingCard shared={shared} /> }}
                        actions={INSTANCE_ACTIONS}
                        copy={{
                            title: t("admin.providers.keys.title"),
                            hint: t("admin.providers.keys.hint"),
                            empty: t("admin.providers.keys.empty"),
                            adding: t("admin.providers.keys.adding")
                        }}
                        after={<CustomProviders />}
                    />
                </Suspense>
                <Suspense fallback={<CardSkeleton lines={1} />}>
                    <Catalog />
                </Suspense>
            </div>
        </Messages>
    );
}

/** The providers this deployment added by address, under the table. */
async function CustomProviders() {
    return <CustomProvidersCard initial={await listCustomProviders()} />;
}

/** How many models the pickers can offer, and when the list was last read. */
async function Catalog() {
    const [models, at, index] = await Promise.all([
        prisma.agentModel.count(),
        catalogRefreshedAt(),
        providerIndexState()
    ]);
    return <CatalogCard models={models} refreshedAt={at?.toISOString() ?? null} index={index ?? null} />;
}
