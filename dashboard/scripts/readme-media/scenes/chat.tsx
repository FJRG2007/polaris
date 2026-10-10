/** Chat: a channel mid-conversation, with new messages arriving. */

import type { ReactNode } from "react";
import { CallHoldContext, type CallHold } from "@/app/(app)/chat/call-hold";
import { ChatShell } from "@/app/(app)/chat/chat-shell";
import { ChannelView } from "@/app/(app)/chat/channel-view";
import { Chrome } from "../runtime/chrome";
import { sendFrame } from "../runtime/stream";
import { CREW, ORG, TEAM, VIEWER } from "../fixtures/people";
import { defineScene, type SceneContext } from "../runtime/scene";
import {
    CHANNEL_ID,
    membersOf,
    THREAD_ROOT_ID,
    arriving,
    chatCategories,
    chatChannels,
    chatSpaces,
    conversation,
    launchThread,
    profileOf,
    spaceEmoji,
    voicePresence
} from "../fixtures/chat";

const STREAM = "/api/chat/stream";
/** Past the four seconds a typing line stays up (`TYPING_TTL_MS`). */
const TYPING_GONE = 4500;

/** How many of the arriving messages the server has by now. */
let delivered = 0;

/** Somebody starts typing, then what they wrote arrives: the two frames the
 *  real stream sends, in that order. */
const PLAY: { run: () => void; hold: number; advance?: number }[] = [
    { run: () => undefined, hold: 1400 },
    { run: () => typing(TEAM.ana), hold: 1800 },
    // The typing line lasts a few seconds past the last keystroke, as it does
    // in the app; the picture is taken once it has gone.
    { run: () => post(), hold: 1600, advance: TYPING_GONE },
    { run: () => typing(CREW.grace), hold: 1600 },
    { run: () => post(), hold: 3200, advance: TYPING_GONE }
];

function typing(who: { id: string; name: string }) {
    sendFrame(STREAM, { kind: "typing", channelId: CHANNEL_ID, userId: who.id, name: who.name });
}

function post() {
    delivered++;
    sendFrame(STREAM, { kind: "posted", seq: delivered, channels: [CHANNEL_ID] });
}

/** Every action a chat screen asks, answered for the conversation `channelId`. */
export function chatActions(ctx: SceneContext, channelId: string) {
    const channels = chatChannels(ctx);
    return {
        chatListsAction: () => ({
            channels,
            spaces: chatSpaces(ctx),
            categories: chatCategories(ctx),
            blocked: [],
            friends: []
        }),
        listChannelsAction: () => ({ channels }),
        chatRulesAction: () => ({ rules: {} }),
        callsUnavailableAction: () => null,
        voicePresenceAction: () => ({ inRoom: voicePresence() }),
        readChannelAction: () => ({
            page: { messages: conversation(ctx, channelId), olderThan: null },
            channel: channels.find((one) => one.id === channelId)
        }),
        readSinceAction: () => ({
            page: {
                messages: channelId === CHANNEL_ID ? arriving(ctx).slice(0, delivered) : [],
                newerThan: null
            }
        }),
        readThreadAction: (rootId: string) => ({
            messages: rootId === THREAD_ROOT_ID ? launchThread(ctx) : []
        }),
        markReadAction: () => ({}),
        receiptsAction: () => ({ receipts: {} }),
        listScheduledAction: () => ({ scheduled: [] }),
        liveCallAction: () => null,
        pinsAction: () => ({ pins: [] }),
        conversationsElsewhereAction: () => ({ chats: [] }),
        listMembersAction: () => ({
            members: membersOf(ctx, channelId).map((one, index) => ({
                userId: one.id,
                name: one.name,
                role: index === 0 ? "owner" : "member"
            }))
        }),
        spaceEmojiAction: () => ({ list: spaceEmoji(ctx) }),
        profileAction: (_channel: string, userId: string) => ({
            profile: profileOf(ctx, userId)
        })
    };
}

/** The chat app open on `channelId`, inside the dashboard's frame. */
export function ChatScreen({
    channelId,
    hold,
    children
}: {
    channelId: string;
    /** The call this tab is in, given to the screens the way the provider in
     *  the frame gives it, so the room draws it from here. */
    hold?: CallHold;
    children?: ReactNode;
}) {
    const shell = (
        <ChatShell
            viewerId={VIEWER.id}
            viewerName={VIEWER.name}
            orgId={ORG.id}
            orgName={ORG.name}
            may={{ spaces: true, groups: true, attach: true, call: true, meetings: true }}
        >
            {children ?? <ChannelView channelId={channelId} />}
        </ChatShell>
    );
    return (
        <Chrome unread={{ chat: 6 }}>
            {hold ? (
                <CallHoldContext.Provider value={hold}>{shell}</CallHoldContext.Provider>
            ) : (
                shell
            )}
        </Chrome>
    );
}

export const chat = defineScene({
    id: "chat",
    path: `/chat/c/${CHANNEL_ID}`,
    params: { channelId: CHANNEL_ID },
    actions: (ctx) => chatActions(ctx, CHANNEL_ID),
    render: () => <ChatScreen channelId={CHANNEL_ID} />,
    animation: {
        frames: PLAY.length,
        step: (index) => PLAY[index]!.run(),
        hold: (index) => PLAY[index]!.hold,
        advance: (index) => PLAY[index]!.advance ?? 400
    }
});
