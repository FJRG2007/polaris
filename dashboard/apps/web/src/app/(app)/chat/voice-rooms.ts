"use client";

/**
 * Who is sitting in which voice room, for anything on the chat screen that
 * draws it.
 *
 * The rail draws the names under each room and the members column draws a line
 * under each name, and both are the same answer: one server action that is
 * answered only for the rooms the reader can reach (`voicePresenceAction`
 * intersects the ids with the same `reachableChannelIds` the server uses
 * everywhere else), followed live by the "call" frames the chat stream already
 * carries.
 */

import * as actions from "./actions";
import { useChatStream } from "./use-chat-stream";
import { useCallback, useEffect, useState } from "react";
import type { VoicePresence } from "@/lib/chat/meetings";
import type { ChatChannelView } from "@/lib/chat/chat-service";

export type VoiceRooms = Record<string, VoicePresence[]>;

/**
 * Who is in each of these voice rooms, kept in step with the stream.
 *
 * @param voiceIds - The rooms to ask about. Ids the reader cannot reach come
 *   back empty, whatever the browser asked for.
 * @param pollMs - Also ask on this interval. Only the rail does: it has a count
 *   beside every room that a missed frame would leave wrong all afternoon.
 */
export function useVoiceRooms(
    voiceIds: readonly string[],
    pollMs?: number
): { inRoom: VoiceRooms; read: () => void } {
    const [inRoom, setInRoom] = useState<VoiceRooms>({});
    const asked = voiceIds.join(",");

    const read = useCallback(() => {
        if (!asked) {
            setInRoom({});
            return;
        }
        void actions
            .voicePresenceAction(asked.split(","))
            .then((result) => setInRoom(result.inRoom))
            .catch(() => undefined);
    }, [asked]);

    // Somebody walking into a room, leaving it or muting is announced, so what
    // is drawn follows at once rather than at the next poll.
    useChatStream((frame) => {
        if (frame.kind === "call" && asked.split(",").includes(frame.channelId)) read();
    });

    useEffect(() => {
        read();
        if (!asked || !pollMs) return;
        const timer = setInterval(read, pollMs);
        return () => clearInterval(timer);
    }, [read, asked, pollMs]);

    return { inRoom, read };
}

/** The voice room somebody is in, as the members column names it. */
export interface VoiceSeat {
    readonly channelId: string;
    readonly channelName: string;
}

/**
 * The voice rooms of one space the reader can see, which is what the members
 * column asks about. Archived rooms are left out the way the rail leaves them.
 */
export function spaceVoiceIds(
    channels: readonly ChatChannelView[],
    spaceId: string | null
): string[] {
    if (!spaceId) return [];
    return channels
        .filter(
            (channel) =>
                channel.spaceId === spaceId && channel.kind === "voice" && !channel.archived
        )
        .map((channel) => channel.id);
}

/**
 * Who is in a voice room of this space, by account.
 *
 * Only rooms in the reader's own channel list count - the server already
 * answered nothing for the rest, and this does not trust that twice removed:
 * a room the reader cannot open is never named beside somebody's face. Seats
 * with no account (a guest on a link) have nobody in the column to draw under.
 * Somebody in two rooms at once - two tabs - is shown in the first by the
 * order the rail lists them.
 */
export function voiceSeats(
    channels: readonly ChatChannelView[],
    spaceId: string | null,
    inRoom: VoiceRooms
): Map<string, VoiceSeat> {
    const found = new Map<string, VoiceSeat>();
    const visible = new Set(spaceVoiceIds(channels, spaceId));
    for (const channel of channels) {
        if (!visible.has(channel.id)) continue;
        for (const seat of inRoom[channel.id] ?? []) {
            if (!seat.userId || found.has(seat.userId)) continue;
            found.set(seat.userId, { channelId: channel.id, channelName: channel.name });
        }
    }
    return found;
}
