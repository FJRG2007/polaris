/**
 * One account's AI providers, with its own actions and words: drawn on Polar's
 * settings and in the Agents section of Connected accounts.
 */

import { getTranslations } from "@/lib/i18n/request";
import { AiProvidersPanel } from "@/components/model-keys/ai-providers-panel";
import { ACCOUNT_ACTIONS, SIGNIN_ACTIONS } from "./account-actions";

export async function AccountProvidersPanel({ userId, narrow = false }: { userId: string; narrow?: boolean }) {
    const t = await getTranslations("account");
    return (
        <AiProvidersPanel
            narrow={narrow}
            owner={{ kind: "account", userId, signin: SIGNIN_ACTIONS }}
            actions={ACCOUNT_ACTIONS}
            copy={{
                title: t("aiKeys.connections.title"),
                hint: t("aiKeys.connections.hint"),
                empty: t("aiKeys.connections.empty"),
                emptyShared: t("aiKeys.connections.emptyShared"),
                adding: t("aiKeys.connections.adding")
            }}
        />
    );
}
