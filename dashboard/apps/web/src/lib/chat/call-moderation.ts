/**
 * Muting, deafening and disconnecting somebody in a call, as a moderator.
 *
 * Only in a conversation's call - a voice channel, a call in a text channel, a
 * group's call - and only by whoever may moderate that conversation: the space's
 * owner and admins (and an admin of the channel itself), or the person whose
 * group it is. The instance's own administrator role has nothing to do with it;
 * see `voice-moderation` for the rule and `access` for the standing.
 *
 * Three things happen, in this order, and the order is the design:
 *
 * 1. The seat's row changes. It is what the next ticket to the media server is
 *    written from, so a browser that reconnects or walks back in is held to it.
 * 2. The media server is told, which is what reaches a browser already in the
 *    room: its microphone stops being accepted, nothing arrives at it, or its
 *    connection is closed. A browser that ignores every notice is held all the
 *    same.
 * 3. The seat itself is told, so the person it happened to reads that a
 *    moderator did it rather than wondering why their microphone died.
 *
 * Server-only.
 */

import { prisma } from "@polaris/db";
import { groupOwnerId } from "./ownership";
import { applyToSeat } from "./call-server";
import { publishMeetingEvent } from "./meeting-events";
import { announceVoiceChange, leave } from "./meetings";
import { ChatAccessError, requireChannel, type ChatActor } from "./access";
import { moderationRefusal, restrictionAfter, type CallModeration } from "./voice-moderation";

/** What the moderator is told back. `unconfirmed` when the decision is stored
 *  but the media server could not be asked to enforce it right now. */
export interface ModerationResult {
    readonly unconfirmed: boolean;
}

/** Said to the moderator when the media server did not take it. True, and
 *  actionable: nothing is lost, and what is stored applies on their next join. */
export const NOT_ENFORCED_YET =
    "Saved, but the call server did not confirm it. It applies as soon as they reconnect.";

export async function moderateSeat(
    actor: ChatActor,
    participantId: string,
    action: CallModeration
): Promise<ModerationResult> {
    const seat = await prisma.meetingParticipant.findFirst({
        where: { id: participantId, leftAt: null, admission: "admitted" },
        select: {
            id: true,
            userId: true,
            meetingId: true,
            serverMuted: true,
            serverDeafened: true,
            meeting: {
                select: {
                    endedAt: true,
                    channelId: true,
                    channel: {
                        select: {
                            kind: true,
                            ownerId: true,
                            createdById: true,
                            space: { select: { ownerId: true } }
                        }
                    }
                }
            }
        }
    });
    if (!seat) throw new ChatAccessError("They are not in this call any more");
    const { meeting } = seat;
    if (meeting.endedAt || !meeting.channelId || !meeting.channel) {
        // A meeting of its own has a host, and the host has their own way to
        // show somebody out - `removeFromMeeting`.
        throw new ChatAccessError("That call has ended");
    }

    const access = await requireChannel(actor, meeting.channelId);
    const group = meeting.channel.kind === "group";
    const refusal = moderationRefusal({
        mayModerate: access.mayModerate,
        actorId: actor.id,
        ownerId: group ? groupOwnerId(meeting.channel) : (meeting.channel.space?.ownerId ?? null),
        targetUserId: seat.userId,
        group
    });
    if (refusal) throw new ChatAccessError(refusal);

    if (action === "disconnect") {
        // Told first: once the connection is closed the browser is no longer
        // listening to anything, and it would find out only that its call
        // dropped.
        publishMeetingEvent({
            meetingId: seat.meetingId,
            kind: "moderated",
            participantId: seat.id,
            action
        });
        // The seat is given up rather than refused, which is the difference from
        // a host removing somebody from a meeting: shown out of a voice channel,
        // anybody may walk back in, as they can everywhere else.
        await leave({ meetingId: seat.meetingId, participantId: seat.id });
        const enforced = await applyToSeat(seat.meetingId, seat.id, { kind: "remove" });
        return { unconfirmed: !enforced };
    }

    const next = restrictionAfter(
        { serverMuted: seat.serverMuted, serverDeafened: seat.serverDeafened },
        action
    );
    await prisma.meetingParticipant.update({ where: { id: seat.id }, data: next });
    const enforced = await applyToSeat(seat.meetingId, seat.id, {
        kind: "restrict",
        restriction: next
    });
    publishMeetingEvent({
        meetingId: seat.meetingId,
        kind: "moderated",
        participantId: seat.id,
        action
    });
    // Everybody in the room redraws the seat from the roster, and the people
    // outside it from the conversation's own announcement - see `announceCall`.
    publishMeetingEvent({ meetingId: seat.meetingId, kind: "roster" });
    await announceVoiceChange(seat.meetingId);
    return { unconfirmed: !enforced };
}
