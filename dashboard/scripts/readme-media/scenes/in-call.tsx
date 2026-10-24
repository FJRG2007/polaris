/**
 * Calls, in the four places one is held: the stand-up voice room, a meeting
 * of its own with cameras on, a call in a group chat being recorded, and a
 * call in a direct message, face to face.
 */

import { TEAM, VIEWER } from "../fixtures/people";
import { label } from "../runtime/interact";
import { defineScene, type SceneContext } from "../runtime/scene";
import { ChatScreen, chatActions, chatApi } from "./chat";
import { MeetingRoom } from "@/app/(app)/chat/meetings/[meetingId]/meeting-room";
import { ANA_DM_ID, GROUP_ID } from "../fixtures/chat";
import {
    PLANNING_ID,
    VOICE_CHANNEL_ID,
    callHold,
    directShape,
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
    api: chatApi,
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
    api: chatApi,
    render: (ctx) => (
        <ChatScreen channelId="" hold={callHold(ctx, planningShape(ctx))}>
            <MeetingRoom meetingId={PLANNING_ID} viewerId={VIEWER.id} />
        </ChatScreen>
    )
});

/** Opens the screen Lena is sharing in the group call, once its card is drawn. */
export async function watchSharedScreen(ctx: SceneContext): Promise<void> {
    const screen = label(ctx.locale, "chat.callRoom.theirScreen").replace("{name}", TEAM.lena.name);
    const title = label(ctx.locale, "chat.callRoom.watchNamed").replace("{name}", screen);
    for (let tries = 0; ; tries++) {
        const card = document.querySelector<HTMLElement>(`button[title="${title}"]`);
        if (card) return card.click();
        if (tries > 50) throw new Error(`no card titled "${title}"`);
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
}

export const callGroup = defineScene({
    id: "call-group",
    path: `/chat/c/${GROUP_ID}`,
    params: { channelId: GROUP_ID },
    actions: (ctx) => chatActions(ctx, GROUP_ID),
    api: chatApi,
    render: (ctx) => <ChatScreen channelId={GROUP_ID} hold={callHold(ctx, groupShape(ctx))} />,
    // A screen arriving in a group call is offered rather than taken; the
    // picture is of one being watched, among the people.
    prepare: watchSharedScreen
});

export const callDirect = defineScene({
    id: "call-direct",
    path: `/chat/c/${ANA_DM_ID}`,
    params: { channelId: ANA_DM_ID },
    actions: (ctx) => chatActions(ctx, ANA_DM_ID),
    api: chatApi,
    render: (ctx) => <ChatScreen channelId={ANA_DM_ID} hold={callHold(ctx, directShape(ctx))} />
});
