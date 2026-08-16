/**
 * What is allowed in a conversation (/admin/chat).
 */

import { PageHeader } from "@polaris/ui";
import { requireAdmin } from "@/lib/session";
import { allChatRules } from "@/lib/chat/rules";
import { ChatRulesView } from "./chat-rules-view";

export const dynamic = "force-dynamic";

export default async function ChatRulesPage() {
    await requireAdmin();
    const rules = await allChatRules();

    return (
        // A column of settings and nothing wide, centred the way the rest of the
        // narrow admin pages are: a limit of three words in a track the width of
        // the screen is the whole reason this page looked wrong.
        <div className="mx-auto flex w-full max-w-2xl flex-col">
            <PageHeader
                title="Chat"
                description="How long a message may be, what it may carry, how long it stays editable, and what a deleted one leaves behind. Answered separately for spaces, group chats and direct messages."
            />
            <ChatRulesView initial={rules} />
        </div>
    );
}
