/**
 * AI provider keys (/account/ai-keys): the provider accounts this person's AI
 * work bills to, and the order they are tried in.
 *
 * An account setting rather than a feature of the Agents app, because it is the
 * same answer wherever Polaris asks a model something: a key you brought is used
 * first, and the deployment's is the fallback for a provider you have not brought
 * one for.
 */

import { Suspense } from "react";
import { requireUser } from "@/lib/session";
import { CardSkeleton } from "@/app/(app)/admin/region-skeletons";
import { AiKeysPanel } from "./ai-keys-panel";
import { ProviderLogins } from "@/components/model-keys/provider-logins";
import { getTranslations } from "@/lib/i18n/request";

export const dynamic = "force-dynamic";

export default async function AiKeysPage() {
    const user = await requireUser();
    const t = await getTranslations("account");

    return (
        <div className="mx-auto flex w-full max-w-6xl flex-col gap-4">
            <div>
                <h1 className="text-[1.0625rem] font-semibold tracking-tight">
                    {t("aiKeys.page.title")}
                </h1>
                <p className="text-muted-foreground text-sm">{t("aiKeys.page.intro")}</p>
            </div>
            <ProviderLogins />
            {/* Streamed: the listing decrypts older keys once to fill their
                hints and asks the router how each one stands, and the heading
                has no reason to wait for either. */}
            <Suspense
                fallback={
                    <>
                        <CardSkeleton lines={4} />
                        <CardSkeleton lines={2} />
                    </>
                }
            >
                <AiKeysPanel userId={user.id} />
            </Suspense>
        </div>
    );
}
