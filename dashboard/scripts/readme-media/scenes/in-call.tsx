/** In a call: the stand-up voice room, with Ana talking. */

import { ChatShell } from "@/app/(app)/chat/chat-shell";
import { ChannelView } from "@/app/(app)/chat/channel-view";
import { CallHoldContext } from "@/app/(app)/chat/call-hold";
import { Chrome } from "../runtime/chrome";
import { defineScene } from "../runtime/scene";
import { VIEWER } from "../fixtures/people";
import { chat } from "./chat";
import { chatChannels } from "../fixtures/chat";
import { VOICE_CHANNEL_ID, callHold } from "../fixtures/call";

export const inCall = defineScene({
    id: "in-call",
    path: `/chat/c/${VOICE_CHANNEL_ID}`,
    params: { channelId: VOICE_CHANNEL_ID },
    actions: (ctx) => ({
        ...chat.actions!(ctx),
        readChannelAction: () => ({
            page: { messages: [], olderThan: null },
            channel: chatChannels(ctx).find((one) => one.id === VOICE_CHANNEL_ID)
        })
    }),
    render: (ctx) => (
        <Chrome unread={{ chat: 6 }}>
            {/* The call this tab holds, given to the screens the way the
                provider above them gives it: the room draws it from here. */}
            <CallHoldContext.Provider value={callHold(ctx)}>
                <ChatShell
                    viewerId={VIEWER.id}
                    viewerName={VIEWER.name}
                    orgId={null}
                    orgName={null}
                    may={{ spaces: true, groups: true, attach: true, call: true, meetings: true }}
                >
                    <ChannelView channelId={VOICE_CHANNEL_ID} />
                </ChatShell>
            </CallHoldContext.Provider>
        </Chrome>
    )
});
