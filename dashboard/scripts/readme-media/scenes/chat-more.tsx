/**
 * Chat in detail, for the page that explains it: a thread, the files and
 * forwards a channel carries, a poll and a message queued for later, a direct
 * message, and the settings that decide how all of it behaves.
 */

import { Chrome } from "../runtime/chrome";
import { defineScene } from "../runtime/scene";
import { ChatScreen, chatActions } from "./chat";
import { label, pressMatching, scrollTo } from "../runtime/interact";
import { ChannelSettings } from "@/app/(app)/chat/channel-settings";
import { ChatRulesView } from "@/app/(app)/admin/chat/chat-rules-view";
import { PrivacyView } from "@/app/(app)/account/privacy/privacy-view";
import { CHAT_RULE_SCOPES, DEFAULT_CHAT_RULES, DEFAULT_PRIVACY } from "@polaris/core";
import { PageHeader } from "@polaris/ui";
import { ANA_DM_ID, CHANNEL_ID, DESIGN_ID, GENERAL_ID, generalScheduled } from "../fixtures/chat";

export const chatThread = defineScene({
    id: "chat-thread",
    path: `/chat/c/${CHANNEL_ID}`,
    params: { channelId: CHANNEL_ID },
    actions: (ctx) => chatActions(ctx, CHANNEL_ID),
    render: () => <ChatScreen channelId={CHANNEL_ID} />,
    // The replies under Lena's screens, opened beside the channel.
    prepare: () => pressMatching(/^3\s/)
});

export const chatMedia = defineScene({
    id: "chat-media",
    path: `/chat/c/${DESIGN_ID}`,
    params: { channelId: DESIGN_ID },
    actions: (ctx) => chatActions(ctx, DESIGN_ID),
    render: () => <ChatScreen channelId={DESIGN_ID} />
});

export const chatPoll = defineScene({
    id: "chat-poll",
    path: `/chat/c/${GENERAL_ID}`,
    params: { channelId: GENERAL_ID },
    actions: (ctx) => ({
        ...chatActions(ctx, GENERAL_ID),
        listScheduledAction: () => ({ scheduled: generalScheduled(ctx) })
    }),
    render: () => <ChatScreen channelId={GENERAL_ID} />
});

export const chatDirect = defineScene({
    id: "chat-direct",
    path: `/chat/c/${ANA_DM_ID}`,
    params: { channelId: ANA_DM_ID },
    actions: (ctx) => chatActions(ctx, ANA_DM_ID),
    render: () => <ChatScreen channelId={ANA_DM_ID} />
});

export const chatChannelSettings = defineScene({
    id: "chat-channel-settings",
    path: `/chat/c/${CHANNEL_ID}/settings`,
    params: { channelId: CHANNEL_ID },
    actions: (ctx) => chatActions(ctx, CHANNEL_ID),
    render: () => (
        <ChatScreen channelId={CHANNEL_ID}>
            <ChannelSettings channelId={CHANNEL_ID} />
        </ChatScreen>
    )
});

export const chatRules = defineScene({
    id: "chat-rules",
    path: "/admin/chat",
    render: (ctx) => (
        <Chrome>
            <div className="mx-auto flex w-full max-w-2xl flex-col">
                <PageHeader
                    title={label(ctx.locale, "admin.chat.page.title")}
                    description={label(ctx.locale, "admin.chat.page.description")}
                />
                <ChatRulesView
                    initial={
                        Object.fromEntries(
                            CHAT_RULE_SCOPES.map((scope) => [scope, DEFAULT_CHAT_RULES])
                        ) as never
                    }
                />
            </div>
        </Chrome>
    ),
    // What a deleted message leaves and whether edits are kept, which are at
    // the foot of the page.
    prepare: (ctx) => scrollTo(label(ctx.locale, "admin.chat.rules.fields.maxAttachments.label"))
});

export const chatPrivacy = defineScene({
    id: "chat-privacy",
    path: "/account/privacy",
    render: (ctx) => (
        <Chrome>
            <div className="mx-auto flex max-w-2xl flex-col gap-4">
                <div>
                    <h1 className="text-[1.0625rem] font-semibold tracking-tight">
                        {label(ctx.locale, "accountPrivacy.page.title")}
                    </h1>
                    <p className="text-sm text-muted-foreground">
                        {label(ctx.locale, "accountPrivacy.page.intro")}
                    </p>
                </div>
                <PrivacyView settings={DEFAULT_PRIVACY} lists={[]} people={[]} />
            </div>
        </Chrome>
    ),
    // Read receipts, and the rules on calling and forwarding below them.
    prepare: (ctx) =>
        scrollTo(label(ctx.locale, "accountPrivacy.fields.readReceipts.label"), "center")
});
