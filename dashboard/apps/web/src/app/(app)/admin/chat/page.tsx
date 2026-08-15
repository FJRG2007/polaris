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
        <>
            <PageHeader
                title="Chat"
                description="How long a message may be, what it may carry, how long it stays editable, and what a deleted one leaves behind. Answered separately for spaces, group chats and direct messages."
            />
            <ChatRulesView initial={rules} />
        </>
    );
}
