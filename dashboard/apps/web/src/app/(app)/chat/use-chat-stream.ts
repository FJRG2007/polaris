"use client";

/**
 * The live channel, read.
 *
 * Every Chat screen subscribes through this rather than opening its own
 * connection: `subscribeSharedStream` already elects one tab per device to hold
 * the wire, so the sidebar, the open conversation and an open thread cost one
 * connection between them however many tabs are up.
 *
 * Frames are validated on arrival. A tab left open across a deploy is talking to
 * a server that may have moved on, and a frame it does not understand has to be
 * ignored rather than crash the screen somebody is reading.
 */

import { z } from "zod";
import { useEffect, useRef } from "react";
import { CHAT_ACTIVITIES } from "@polaris/core";
import { subscribeSharedStream } from "@/lib/shared-stream";
import { useSessionScope } from "@/components/session-scope";

const STREAM_PATH = "/api/chat/stream";

const frameSchema = z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("posted"), seq: z.number(), channels: z.array(z.string()) }),
    z.object({ kind: z.literal("channels") }),
    z.object({
        kind: z.literal("typing"),
        channelId: z.string(),
        userId: z.string(),
        name: z.string(),
        // Absent from a server still running the build before recordings were
        // announced, which is a tab left open across a deploy.
        activity: z.enum(CHAT_ACTIVITIES).optional()
    }),
    // A call in a conversation started, grew, shrank or ended. `ringing` is the
    // one that sounds; the rest keep the count beside the call button honest,
    // which nothing else does - starting and leaving a call post no message.
    z.object({
        kind: z.literal("call"),
        channelId: z.string(),
        meetingId: z.string(),
        state: z.enum(["ringing", "moved", "ended"]),
        count: z.number(),
        userId: z.string(),
        name: z.string(),
        // Where the call has gone, when a one-to-one had to become a group to
        // take a third person. The browser in the old room follows it.
        movedTo: z.object({ meetingId: z.string(), channelId: z.string() }).optional()
    })
]);

export type ChatFrame = z.infer<typeof frameSchema>;

/** What else is true about a frame besides what it says. */
export interface FrameContext {
    /**
     * Whether this tab took the frame off the wire rather than being handed it
     * by another tab on the same device.
     *
     * Anything that belongs to the device rather than to a screen - a sound, a
     * notification the operating system draws - is the owner's to do, or five
     * open tabs ring five times.
     */
    readonly owner: boolean;
}

/**
 * Call `onFrame` for every frame this device receives.
 *
 * The callback is held in a ref so a caller can close over fresh state without
 * re-subscribing on every render - a subscription that tore down and reopened
 * per keystroke would spend its life reconnecting.
 */
export function useChatStream(onFrame: (frame: ChatFrame, context: FrameContext) => void): void {
    const scope = useSessionScope();
    const handler = useRef(onFrame);
    handler.current = onFrame;

    useEffect(() => {
        return subscribeSharedStream(STREAM_PATH, scope, (event) => {
            let parsed: unknown;
            try {
                parsed = JSON.parse(event.data);
            } catch {
                return;
            }
            const frame = frameSchema.safeParse(parsed);
            if (frame.success) handler.current(frame.data, { owner: event.owner });
        });
    }, [scope]);
}
