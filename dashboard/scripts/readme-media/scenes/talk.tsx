/**
 * Talk in one loop: every kind of call the chat holds, one after another - the
 * stand-up voice room, a video call in a direct message, a group call watching
 * a shared screen while it is recorded, and a meeting of its own with cameras.
 *
 * Each beat is one of the call scenes, mounted at its own route.
 */

import { chatActions } from "./chat";
import { tourScene } from "../runtime/tour";
import type { SceneContext, SceneDefinition } from "../runtime/scene";
import { scenePath } from "../runtime/route";
import { meetingLines, meetingSummary, planningShape } from "../fixtures/call";
import { callDirect, callGroup, callMeeting, inCall, watchSharedScreen } from "./in-call";

const tour = tourScene(
    [inCall, callDirect, callGroup, callMeeting],
    [
        { hold: 2600 },
        { view: 1, hold: 2600 },
        { view: 2, run: watchSharedScreen, hold: 3000 },
        { view: 3, hold: 3000 }
    ]
);

export const talk: SceneDefinition = {
    ...tour,
    id: "talk",
    // The chat's answers depend on the conversation open, which changes from
    // beat to beat: each one is asked for the route on screen when it is called.
    actions: (ctx: SceneContext) => {
        const names = Object.keys(chatActions(ctx, ""));
        const routed = Object.fromEntries(
            names.map((name) => [
                name,
                (...args: never[]) => {
                    const channel = scenePath.params().channelId ?? "";
                    const answers = chatActions(ctx, channel) as Record<
                        string,
                        (...rest: never[]) => unknown
                    >;
                    return answers[name]!(...args);
                }
            ])
        );
        return {
            ...routed,
            listMeetingsAction: () => ({ meetings: [meetingSummary(ctx, planningShape(ctx))] }),
            saidInMeetingAction: () => ({ lines: meetingLines(ctx) })
        };
    }
};
