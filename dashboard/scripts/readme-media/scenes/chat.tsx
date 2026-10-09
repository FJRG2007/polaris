/** Chat: a channel mid-conversation, with new messages arriving. */

import { ChatShell } from "@/app/(app)/chat/chat-shell";
import { ChannelView } from "@/app/(app)/chat/channel-view";
import { Chrome } from "../runtime/chrome";
import { defineScene } from "../runtime/scene";
import { sendFrame } from "../runtime/stream";
import { TEAM, VIEWER } from "../fixtures/people";
import {
    CHANNEL_ID,
    arriving,
    chatCategories,
    chatChannels,
    chatSpaces,
    launchConversation
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
    { run: () => typing(TEAM.priya), hold: 1600 },
    { run: () => post(), hold: 3200, advance: TYPING_GONE }
];

function typing(who: { id: string; name: string }) {
    sendFrame(STREAM, { kind: "typing", channelId: CHANNEL_ID, userId: who.id, name: who.name });
}

function post() {
    delivered++;
    sendFrame(STREAM, { kind: "posted", seq: delivered, channels: [CHANNEL_ID] });
}

export const chat = defineScene({
    id: "chat",
    path: `/chat/c/${CHANNEL_ID}`,
    params: { channelId: CHANNEL_ID },
    actions: (ctx) => ({
        chatListsAction: () => ({
            channels: chatChannels(ctx),
            spaces: chatSpaces(ctx),
            categories: chatCategories(ctx),
            blocked: [],
            friends: []
        }),
        listChannelsAction: () => ({ channels: chatChannels(ctx) }),
        chatRulesAction: () => ({ rules: {} }),
        callsUnavailableAction: () => null,
        voicePresenceAction: () => ({ inRoom: {} }),
        readChannelAction: () => ({
            page: { messages: launchConversation(ctx), olderThan: null },
            channel: chatChannels(ctx)[0]
        }),
        readSinceAction: () => ({
            page: { messages: arriving(ctx).slice(0, delivered), newerThan: null }
        }),
        markReadAction: () => ({}),
        receiptsAction: () => ({ receipts: {} }),
        listScheduledAction: () => ({ scheduled: [] }),
        liveCallAction: () => null,
        pinsAction: () => ({ pins: [] }),
        conversationsElsewhereAction: () => ({ chats: [] }),
        listMembersAction: () => ({
            members: [VIEWER, ...Object.values(TEAM)].map((one, index) => ({
                userId: one.id,
                name: one.name,
                role: index === 0 ? "owner" : "member"
            }))
        }),
        spaceEmojiAction: () => ({ list: { emoji: [], manages: true } })
    }),
    render: () => (
        <Chrome unread={{ chat: 6 }}>
            <ChatShell
                viewerId={VIEWER.id}
                viewerName={VIEWER.name}
                orgId={null}
                orgName={null}
                may={{ spaces: true, groups: true, attach: true, call: true, meetings: true }}
            >
                <ChannelView channelId={CHANNEL_ID} />
            </ChatShell>
        </Chrome>
    ),
    animation: {
        frames: PLAY.length,
        step: (index) => PLAY[index]!.run(),
        hold: (index) => PLAY[index]!.hold,
        advance: (index) => PLAY[index]!.advance ?? 400
    }
});
