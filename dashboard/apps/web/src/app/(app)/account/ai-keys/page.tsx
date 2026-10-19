/**
 * AI provider keys (/account/ai-keys): the provider accounts this person's AI
 * work bills to, and the order they are tried in.
 *
 * An account setting rather than a feature of the Agents app, because it is the
 * same answer wherever Polaris asks a model something: a key you brought is used
 * first, and the deployment's is the fallback for a provider you have not brought
 * one for.
 */

import { requireUser } from "@/lib/session";
import { AiKeysPanel } from "./ai-keys-panel";
import { getTranslations } from "@/lib/i18n/request";

export const dynamic = "force-dynamic";

export default async function AiKeysPage() {
    const user = await requireUser();
    const t = await getTranslations("account");

    return (
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-4">
            <div>
                <h1 className="text-[1.0625rem] font-semibold tracking-tight">
                    {t("aiKeys.page.title")}
                </h1>
                <p className="text-muted-foreground text-sm">{t("aiKeys.page.intro")}</p>
            </div>
            <AiKeysPanel userId={user.id} />
        </div>
    );
}
