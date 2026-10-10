/**
 * Calls, in the three places one is held: the stand-up voice room, a meeting
 * of its own with cameras on, and a call in a group chat being recorded.
 */

import { VIEWER } from "../fixtures/people";
import { defineScene } from "../runtime/scene";
import { ChatScreen, chatActions } from "./chat";
import { MeetingRoom } from "@/app/(app)/chat/meetings/[meetingId]/meeting-room";
import { GROUP_ID } from "../fixtures/chat";
import {
    PLANNING_ID,
    VOICE_CHANNEL_ID,
    callHold,
    groupShape,
    meetingLines,
    meetingSummary,
    planningShape,
    standupShape
} from "../fixtures/call";

export const inCall = defineScene({
    id: "in-call",
    path: `/chat/c/${VOICE_CHANNEL_ID}`,
    params: { channelId: VOICE_CHANNEL_ID },
    actions: (ctx) => chatActions(ctx, VOICE_CHANNEL_ID),
    render: (ctx) => (
        <ChatScreen channelId={VOICE_CHANNEL_ID} hold={callHold(ctx, standupShape(ctx))} />
    )
});

export const callMeeting = defineScene({
    id: "call-meeting",
    path: `/chat/meetings/${PLANNING_ID}`,
    params: { meetingId: PLANNING_ID },
    actions: (ctx) => ({
        ...chatActions(ctx, ""),
        listMeetingsAction: () => ({ meetings: [meetingSummary(ctx, planningShape(ctx))] }),
        saidInMeetingAction: () => ({ lines: meetingLines(ctx) })
    }),
    render: (ctx) => (
        <ChatScreen channelId="" hold={callHold(ctx, planningShape(ctx))}>
            <MeetingRoom meetingId={PLANNING_ID} viewerId={VIEWER.id} />
        </ChatScreen>
    )
});

export const callGroup = defineScene({
    id: "call-group",
    path: `/chat/c/${GROUP_ID}`,
    params: { channelId: GROUP_ID },
    actions: (ctx) => chatActions(ctx, GROUP_ID),
    render: (ctx) => <ChatScreen channelId={GROUP_ID} hold={callHold(ctx, groupShape(ctx))} />
});
