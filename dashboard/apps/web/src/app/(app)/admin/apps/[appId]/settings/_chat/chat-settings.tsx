/**
 * What is allowed in a conversation, and where its calls run: the Chat app's
 * administrator settings, drawn by Polaris apps > Chat > Settings. The caller
 * has already checked that the reader is an administrator.
 */

import { allChatRules } from "@/lib/chat/rules";
import { ChatRulesView } from "./chat-rules-view";
import { CallServerView } from "./call-server-view";
import { OrgChatView } from "./org-chat-view";
import { orgChatOffered } from "@/lib/chat/isolation";
import { driveShare } from "@/lib/chat/drive-share";
import { DriveShareView } from "./drive-share-view";
import { linkSafetyOverview } from "@/lib/chat/link-safety";
import { LinkSafetyView } from "./link-safety-view";

export async function ChatAdminSettings() {
    const [rules, offered, share, linkSafety] = await Promise.all([
        allChatRules(),
        orgChatOffered(),
        driveShare(),
        linkSafetyOverview()
    ]);

    return (
        // A column of settings and nothing wide: a limit of three words in a track
        // the width of the screen is the whole reason the old page looked wrong.
        <div className="flex w-full max-w-2xl flex-col">
            <ChatRulesView initial={rules} />
            {/* Beside the size limit it qualifies: the limit is about what this
                instance stores, and this is what decides whether sending a file
                stores anything at all. */}
            <div className="mt-8">
                <DriveShareView how={share} />
            </div>
            {/* Under the rules and above the call server: it is a house rule
                like the ones over it, and it is asked about far more often than
                where calls run. */}
            <div className="mt-8">
                <OrgChatView offered={offered} />
            </div>
            <div className="mt-8">
                <LinkSafetyView initial={linkSafety} />
            </div>
            {/* Under the rules rather than above them: the rules are what an
                administrator comes here to change, and this is set once and then
                never again. */}
            <div className="mt-8">
                <CallServerView />
            </div>
        </div>
    );
}
