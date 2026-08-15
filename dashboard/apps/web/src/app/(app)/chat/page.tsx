/**
 * Chat with nothing open.
 *
 * On a phone this never renders - the shell shows the conversation list on its
 * own - so this is the wide-screen case, where the list is already beside it and
 * what is missing is a choice.
 */

import { EmptyState } from "@polaris/ui";
import { MessageCircle } from "lucide-react";

export default function ChatIndexPage() {
    return (
        <div className="flex flex-1 items-center justify-center p-6">
            <EmptyState
                icon={<MessageCircle />}
                title="Pick a conversation."
                description="Or start one: a direct message to somebody, or a space with channels in it."
            />
        </div>
    );
}
