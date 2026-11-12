/**
 * The Chat app's administrator settings, one screen per subject: what is
 * allowed in a conversation, files sent from Drive, chat inside organizations,
 * link safety, and where calls run. Each is its own page under Polaris apps >
 * Chat > Settings, listed in the app's own rail (`adminAppSubapp`). The caller
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

/** The screens, by the path segment after `settings` ("" is the first). */
export const CHAT_ADMIN_SCREENS = ["", "files", "organizations", "links", "calls"] as const;
export type ChatAdminScreen = (typeof CHAT_ADMIN_SCREENS)[number];

export function isChatAdminScreen(value: string): value is ChatAdminScreen {
    return (CHAT_ADMIN_SCREENS as readonly string[]).includes(value);
}

/** One screen's settings, reading only what that screen draws. */
export async function ChatAdminSettings({ screen }: { screen: ChatAdminScreen }) {
    return (
        // A column of settings and nothing wide: a limit of three words in a track
        // the width of the screen is the whole reason the old page looked wrong.
        <div className="flex w-full max-w-2xl flex-col">
            {screen === "" ? <ChatRulesView initial={await allChatRules()} /> : null}
            {screen === "files" ? <DriveShareView how={await driveShare()} /> : null}
            {screen === "organizations" ? <OrgChatView offered={await orgChatOffered()} /> : null}
            {screen === "links" ? <LinkSafetyView initial={await linkSafetyOverview()} /> : null}
            {screen === "calls" ? <CallServerView /> : null}
        </div>
    );
}
