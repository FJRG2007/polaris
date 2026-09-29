/**
 * Chat with nothing open.
 *
 * On a phone this never renders - the shell shows the conversation list on its
 * own - so this is the wide-screen case, where the list is already beside it and
 * what is missing is a choice.
 */

import { EmptyState } from "@polaris/ui";
import { getTranslations } from "@/lib/i18n/request";
import { MessageCircle } from "lucide-react";

export default async function ChatIndexPage() {
    const t = await getTranslations("chat");
    return (
        <div className="flex flex-1 items-center justify-center p-6">
            <EmptyState
                icon={<MessageCircle />}
                title={t("home.pickAConversation")}
                description={t("home.orStartOneADirect")}
            />
        </div>
    );
}
