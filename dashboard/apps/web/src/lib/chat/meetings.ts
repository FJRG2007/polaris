/**
 * Calls.
 *
 * The media never touches this process. It goes to the call server the stack
 * runs beside it, which is the piece that makes a call between two houses
 * possible at all; what this module does is hold the list of who is in the room
 * and decide who is allowed in. Where that server is and how a browser is let
 * through its door is `call-server.ts`.
 *
 * Two ways in, and they are deliberately different:
 *
 *   - An account, which reaches a call the same way it reaches the conversation
 *     the call is in. There is no separate call permission: if you can read the
 *     channel, you can join the call in it.
 *   - A guest link, which is a per-meeting token that an account holder chose to
 *     create. It grants exactly one room and only while that room is running,
 *     and by default it puts the holder in a lobby until somebody inside admits
 *     them - a link that can be forwarded is a link that will be.
 */

import { randomBytes } from "node:crypto";
import { prisma, type Prisma } from "@polaris/db";
import {
    MAX_MEETING_LINE,
    MAX_MEETING_TITLE,
    MAX_SCHEDULE_AHEAD_MS,
    MEETING_LINES
} from "./meeting-limits";
import { blockersOf } from "@/lib/blocks";
import { publishMeetingEvent } from "./meeting-events";
import { publishChatChange, type CallState } from "./live";
import { ChatAccessError, requireChannel, type ChatActor } from "./access";
import { getIntegrationSecret, getIntegrationState } from "@/lib/integration-service";

/** How many browsers one call holds.
 *
 *  Every browser sends its own video to every other one, so eight people is
 *  fifty-six streams and a laptop fan. Past this the answer is a server that
 *  mixes the call, which Polaris deliberately does not run. */
export const MAX_IN_CALL = 8;

/** How long a participant may go quiet before they are treated as gone. Their
 *  browser refreshes this while the call is on screen; a closed laptop stops. */
export const PARTICIPANT_TTL_MS = 30_000;

/**
 * How long somebody may sit in a one-to-one call on their own before it ends
 * itself.
 *
 * A call nobody answered, or one the other person walked out of, otherwise runs
 * until the tab is closed - holding a camera light on, a connection open and a
 * guest link live. Two minutes: long enough that stepping away to answer the
 * door does not end it, and short enough that being left alone on a line reads
 * as the call being over rather than as a room to keep sitting in.
 *
 * Only in a direct message. A channel call is a room people drop into, and the
 * first person to arrive being thrown out for being early is exactly wrong.
 */
export const ALONE_TTL_MS = 2 * 60_000;

export interface MeetingParticipantView {
    readonly id: string;
    readonly userId: string | null;
    readonly name: string;
    readonly admission: "admitted" | "waiting" | "denied";
    readonly guest: boolean;
    readonly joinedAt: string;
}

export interface MeetingView {
    readonly id: string;
    readonly channelId: string | null;
    readonly hostId: string;
    readonly title: string;
    readonly startedAt: string;
    readonly ended: boolean;
    /** The link for people with no account, or null when the host did not open
     *  one. Only ever handed to somebody who is already in the call. */
    readonly guestToken: string | null;
    readonly approveGuests: boolean;
    /** Whether the link only lets somebody in once they have signed in. */
    readonly requireAccount: boolean;
    /** When it was meant to happen, for a meeting somebody put in the diary.
     *  Null for a call that started when a button was pressed. */
    readonly scheduledAt: string | null;
    /** Whether this is a room of its own rather than a conversation's call.
     *  What can be done to it differs - a conversation's call has no host to
     *  hand over and no door to lock. */
    readonly standalone: boolean;
    readonly participants: readonly MeetingParticipantView[];
}

/** A meeting on somebody's list, before they are in it. */
export interface MeetingSummary {
    readonly id: string;
    readonly title: string;
    readonly hostId: string;
    readonly hostName: string;
    readonly scheduledAt: string | null;
    readonly startedAt: string;
    /** How many people are in the room right now. Zero for one that has not
     *  started, which is most of a list of things happening later. */
    readonly present: number;
    /** The link to hand out, and only ever to the host: it is the credential,
     *  and everybody else on this list was invited by name. */
    readonly guestToken: string | null;
    readonly requireAccount: boolean;
    readonly approveGuests: boolean;
    readonly mine: boolean;
    /** Who has been convened, so the host can see who they asked. */
    readonly invited: readonly { readonly id: string; readonly name: string }[];
}

/** Who this browser is in a call: its own participant row. */
export interface MeetingSeat {
    readonly meetingId: string;
    readonly participantId: string;
    /** Set only for a guest, and only on the join that minted it. */
    readonly guestKey?: string;
    readonly admission: "admitted" | "waiting" | "denied";
}

/**
 * The licensed noise filter this instance was given, if any.
 *
 * Polaris ships two free models and neither costs anybody anything. This is for
 * the operator who has paid for a better one - Krisp being the one people ask
 * for, because it is what Discord runs - and it is a URL and a token rather than
 * an integration with that vendor: their build is theirs to host, and nothing
 * here knows or cares whose model it is.
 *
 * Both halves end up in a browser, which is unavoidable for something that
 * filters a microphone, so this is only ever answered to somebody sitting in a
 * call.
 */
export async function licensedFilter(): Promise<{ moduleUrl: string; token: string } | null> {
    const state = await getIntegrationState(LICENSED_FILTER).catch(() => null);
    if (!state?.enabled) return null;

    const moduleUrl = typeof state.config.moduleUrl === "string" ? state.config.moduleUrl : "";
    if (!moduleUrl) return null;

    const token = (await getIntegrationSecret(LICENSED_FILTER).catch(() => null)) ?? "";
    return { moduleUrl, token };
}

/** The integration slug behind `licensedFilter`. */
export const LICENSED_FILTER = "krisp";

/**
 * Start a call in a conversation, or join the one already running in it.
 *
 * One live call per conversation, always. Two people pressing the button at the
 * same moment mean one call with both of them in it, not two rooms with one
 * person each staring at nothing - which a check followed by a create cannot
 * promise on its own, so `liveKey` carries the conversation while the call runs
 * and the database refuses the second one.
 */
export async function startOrJoin(
    actor: ChatActor & { name: string },
    channelId: string
): Promise<MeetingSeat> {
    await requireChannel(actor, channelId);
    const meetingId = await liveMeetingId(actor, channelId);
    // Swept first, and this is the line the whole thing turned on: a browser
    // that was closed mid-call leaves its seat behind, and a room with a seat
    // in it is not empty. So the next call into that conversation announced
    // itself as somebody *joining* an existing call - and nobody's telephone
    // rang, once, ever again, for as long as the abandoned seat sat there.
    await sweep(meetingId);
    // Asked before the seat is taken, so "was anybody already here" is a
    // question about the room rather than about the room plus the person now
    // walking into it. An empty room is a call starting, which is what makes
    // everybody else's browser ring; an occupied one is somebody joining.
    const wasEmpty = (await admittedCount(meetingId)) === 0;
    const seat = await seatFor(meetingId, actor.id, actor.name);
    await announceCall(meetingId, wasEmpty ? "ringing" : "moved", actor.id, actor.name);
    return seat;
}

/**
 * Bring somebody else into a call that is already running.
 *
 * In a group or a channel this is what it sounds like: they are added to the
 * conversation if they are not in it, and their telephone rings. Only theirs -
 * a group of ten whose members already decided not to join this call must not
 * ring again every time somebody is invited.
 *
 * In a one-to-one it cannot stay where it is. A direct message is between the
 * two people it is keyed by; a third person in it is a different conversation,
 * which is why every messenger answers this the same way. So a group is made
 * with the people who were talking and the people being brought in, the call
 * moves into it, and the person who was already on the line follows - their
 * browser is told where it went rather than left in a room that quietly empties.
 *
 * @returns the call to be in now, which is the same one unless it moved.
 */
export async function inviteToCall(
    actor: ChatActor & { name: string },
    meetingId: string,
    userIds: readonly string[],
    /** Adding people to a conversation, which this needs and which lives next
     *  door. Passed in rather than imported: `chat-service` already imports this
     *  module's neighbours, and a cycle between the two is the one thing that
     *  would make either untestable. */
    addMembers: (channelId: string, userIds: readonly string[]) => Promise<void>,
    /** Opening the group the call moves into. Same reason. */
    openGroup: (userIds: readonly string[]) => Promise<string>
): Promise<{ meetingId: string; channelId: string; moved: boolean }> {
    const wanted = [...new Set(userIds)].filter((id) => id !== actor.id);
    if (wanted.length === 0) throw new ChatAccessError("Pick somebody to bring in");

    const meeting = await prisma.meeting.findUnique({
        where: { id: meetingId },
        select: { channelId: true, endedAt: true }
    });
    if (!meeting?.channelId || meeting.endedAt) throw new ChatAccessError("That call has ended");
    const from = meeting.channelId;
    await requireChannel(actor, from);

    const channel = await prisma.chatChannel.findUnique({
        where: { id: from },
        select: { kind: true, members: { select: { userId: true } } }
    });
    if (!channel) throw new ChatAccessError("That call has ended");

    if (channel.kind !== "dm") {
        await addMembers(from, wanted);
        // Rung, and rung at the people being brought in. `startOrJoin` decides
        // between ringing and moving from whether the room was empty, which is
        // the right question for somebody walking in and the wrong one here:
        // the room is not empty, and these are exactly the people who should
        // hear a telephone.
        await ring(meetingId, from, actor, wanted);
        return { meetingId, channelId: from, moved: false };
    }

    // The two who were talking, plus whoever is being brought in. Taken from the
    // conversation rather than from the call: somebody who stepped out a minute
    // ago is still part of it, and a group that left them behind would be a
    // second conversation nobody asked for.
    const everyone = [...new Set([...channel.members.map((row) => row.userId), ...wanted])];
    const groupId = await openGroup(everyone.filter((id) => id !== actor.id));

    const seat = await startOrJoin(actor, groupId);
    // The person still sitting in the old room, told where it went. Their own
    // browser does the moving; nothing here can take a microphone from them.
    publishChatChange({
        channelId: from,
        kind: "call",
        actorId: actor.id,
        actorName: actor.name,
        call: { meetingId, state: "moved", count: await admittedCount(meetingId) },
        movedTo: { meetingId: seat.meetingId, channelId: groupId }
    });
    await ring(seat.meetingId, groupId, actor, wanted);
    return { meetingId: seat.meetingId, channelId: groupId, moved: true };
}

/**
 * Ring exactly these people about this call.
 *
 * Anybody who has blocked the caller is left out, and a ring with nobody left to
 * hear it is not published at all. A telephone is the loudest thing one account
 * can do to another, so it is the last place a block may be walked around - and
 * this is where being brought into a call by a third person is caught, which
 * every other check on the way here would have missed.
 */
async function ring(
    meetingId: string,
    channelId: string,
    actor: ChatActor & { name: string },
    audience: readonly string[]
): Promise<void> {
    const shut = await blockersOf(actor.id, audience);
    const heard = audience.filter((userId) => !shut.has(userId));
    if (heard.length === 0) return;

    publishChatChange({
        channelId,
        kind: "call",
        actorId: actor.id,
        actorName: actor.name,
        audience: heard,
        call: { meetingId, state: "ringing", count: await admittedCount(meetingId) }
    });
}

/** Join a call by id, as an account. The conversation it is in decides. */
export async function join(
    actor: ChatActor & { name: string },
    meetingId: string
): Promise<MeetingSeat> {
    const meeting = await prisma.meeting.findUnique({
        where: { id: meetingId },
        select: { channelId: true, endedAt: true }
    });
    if (!meeting || meeting.endedAt) throw new ChatAccessError("That call has ended");
    if (meeting.channelId) await requireChannel(actor, meeting.channelId);
    else throw new ChatAccessError("That call has ended");

    const seat = await seatFor(meetingId, actor.id, actor.name);
    await announceCall(meetingId, "moved", actor.id, actor.name);
    return seat;
}

/**
 * Join on a guest link.
 *
 * The token is the whole credential, so what it grants is deliberately small:
 * one room, while it runs, under a name the guest typed. With approval on - the
 * default - the seat starts in the lobby and no signalling reaches it until
 * somebody inside admits them.
 */
/** Said to somebody on a link into a meeting whose host asked for accounts. It
 *  is an instruction rather than a refusal: there is a way in, and this is it. */
export const SIGN_IN_FIRST = "This meeting is only open to people signed in to Polaris";

export async function joinAsGuest(token: string, name: string): Promise<MeetingSeat> {
    const meeting = await prisma.meeting.findUnique({
        where: { guestToken: token },
        select: { id: true, endedAt: true, approveGuests: true, requireAccount: true }
    });
    if (!meeting || meeting.endedAt) throw new ChatAccessError("That call has ended");
    // The host asked for people to be signed in. The link still names the
    // meeting - it is how somebody knows what they are signing in for - and this
    // is the only way through it.
    if (meeting.requireAccount) throw new ChatAccessError(SIGN_IN_FIRST);
    await requireRoom(meeting.id);

    const guestKey = randomBytes(32).toString("base64url");
    const participant = await prisma.meetingParticipant.create({
        data: {
            meetingId: meeting.id,
            userId: null,
            name,
            guestKey,
            admission: meeting.approveGuests ? "waiting" : "admitted"
        },
        select: { id: true, admission: true }
    });

    publishMeetingEvent({ meetingId: meeting.id, kind: "roster" });
    return {
        meetingId: meeting.id,
        participantId: participant.id,
        guestKey,
        admission: participant.admission as MeetingSeat["admission"]
    };
}

/** Let somebody in, or turn them away. Anybody already in the call may do it -
 *  a lobby only one person can open is a lobby that strands people whenever that
 *  person is the one who stepped out. Anybody *in* the call: a seat at the door
 *  is not a seat in the room, or the lobby would be a formality a forwarded link
 *  walks straight past. */
export async function decideAdmission(
    seat: { meetingId: string; participantId: string },
    targetId: string,
    admitted: boolean
): Promise<void> {
    const seated = await requireSeated(seat);
    if (seated.admission !== "admitted") {
        throw new ChatAccessError("You are still waiting to be let in");
    }
    if (admitted) await requireRoom(seat.meetingId);

    await prisma.meetingParticipant.updateMany({
        where: { id: targetId, meetingId: seat.meetingId, admission: "waiting" },
        data: { admission: admitted ? "admitted" : "denied" }
    });
    publishMeetingEvent({ meetingId: seat.meetingId, kind: "roster" });
}

/**
 * Still here. Called on a heartbeat from the browser showing the call.
 *
 * The heartbeat is also where a lone call is closed, and deliberately: the
 * person sitting on their own is the one whose browser is beating, so the room
 * they are alone in is shut by the only party still paying for it. Nowhere that
 * somebody *joins* runs that check, or a call the host has been waiting in would
 * end in the instant the other person arrives.
 */
export async function keepSeat(seat: { meetingId: string; participantId: string }): Promise<void> {
    await prisma.meetingParticipant.updateMany({
        where: { id: seat.participantId, meetingId: seat.meetingId, leftAt: null },
        data: { lastSeenAt: new Date() }
    });
    await endIfAlone(seat.meetingId);
}

/**
 * A call this account is in, somewhere that is not here.
 *
 * An account holds one seat in a call - a second device reuses the same
 * participant row, because a person is one person in a room - so signing in on a
 * phone while a call is running on a desk does not put anybody in two rooms. It
 * put two browsers on one seat, silently, both holding a microphone open, and
 * neither with any way to find out about the other. What the reader saw was a
 * phone that said nothing and a call on the computer that behaved strangely.
 *
 * So the phone asks this on the way in, and offers to take the call over.
 *
 * Freshness is the whole of the test. A seat is left behind by any browser that
 * was closed rather than hung up, and offering to move a call that ended
 * yesterday is worse than offering nothing - so a seat that has not checked in
 * within the sweep window is not a call anybody is in.
 */
export interface CallElsewhere {
    readonly meetingId: string;
    readonly channelId: string;
    readonly participantId: string;
    /** What to call it on the card and, once it is moved, in the bar. Named
     *  here because the browser asking has no conversation on screen to read it
     *  off - it may be anywhere in Polaris, or freshly signed in. */
    readonly title: string;
}

export async function callElsewhere(userId: string): Promise<CallElsewhere | null> {
    const seat = await prisma.meetingParticipant.findFirst({
        where: {
            userId,
            admission: "admitted",
            leftAt: null,
            lastSeenAt: { gte: new Date(Date.now() - PARTICIPANT_TTL_MS) },
            meeting: { endedAt: null }
        },
        orderBy: { lastSeenAt: "desc" },
        select: {
            id: true,
            meetingId: true,
            meeting: {
                select: {
                    channelId: true,
                    channel: {
                        select: {
                            kind: true,
                            name: true,
                            spaceId: true,
                            // Everybody but the person asking, which is what a
                            // one-to-one is called: it has no name of its own.
                            members: {
                                where: { userId: { not: userId } },
                                select: { user: { select: { name: true } } },
                                take: MAX_TITLE_NAMES
                            }
                        }
                    }
                }
            }
        }
    });
    const channel = seat?.meeting.channel;
    if (!seat?.meeting.channelId || !channel) return null;

    const named = channel.spaceId
        ? channel.kind === "text"
            ? `#${channel.name}`
            : channel.name
        : channel.name ||
          channel.members.map((member) => member.user.name).join(", ") ||
          "Just you";

    return {
        meetingId: seat.meetingId,
        channelId: seat.meeting.channelId,
        participantId: seat.id,
        title: named || "Call"
    };
}

/** How many people to name in a group's title. Past this it is a list nobody
 *  reads on a card the width of a phone. */
const MAX_TITLE_NAMES = 4;

/**
 * Say which browser is on the call now.
 *
 * A claim is about one seat, and it carries which one. That was the missing
 * half: it used to say only "this device has it", which every browser in the
 * room read as being addressed to them, and a device id nobody else could
 * recognise means everybody else concluded they had been replaced. The result
 * was that two people could not hold a call - the second to arrive ended the
 * first, whose rejoin then ended the second - and nothing on either screen
 * explained why the call kept dropping.
 *
 * With the seat on it the claim reaches only the browsers sitting in that seat,
 * which is the set it was always meant for: an account's other devices.
 *
 * Nothing is stored. The claim is only true until the next one, which is the
 * whole of what it has to be - and a column recording "the current device" would
 * be a fact about a browser session living in the call's row, outliving both.
 */
export function claimCall(meetingId: string, participantId: string, deviceId: string): void {
    publishMeetingEvent({ meetingId, kind: "claimed", participantId, deviceId });
}

/** Leave. The last one out ends the call, so a room is never left running with
 *  nobody in it and a live guest link pointing at it. */
export async function leave(seat: { meetingId: string; participantId: string }): Promise<void> {
    await prisma.meetingParticipant.updateMany({
        where: { id: seat.participantId, leftAt: null },
        data: { leftAt: new Date() }
    });
    await endIfEmpty(seat.meetingId);
    publishMeetingEvent({ meetingId: seat.meetingId, kind: "roster" });
    // Whoever is looking at the conversation without being in the call needs
    // the count beside the button to go down, which nothing else would tell
    // them: leaving posts no message either.
    await announceCall(seat.meetingId, "moved", "");
}

/** End it for everybody. Only the host. */
export async function end(actor: ChatActor, meetingId: string): Promise<void> {
    const meeting = await prisma.meeting.findUnique({
        where: { id: meetingId },
        select: { hostId: true }
    });
    if (!meeting || meeting.hostId !== actor.id) {
        throw new ChatAccessError("Only whoever started the call can end it");
    }
    await closeMeeting(meetingId);
}

/**
 * Open, or close, the link for people with no account.
 *
 * Closing it mints nothing and revokes what was handed out, because the token is
 * the credential: a guest already in the room stays, and nobody else gets in on
 * that link again.
 */
export async function setGuestLink(
    actor: ChatActor,
    meetingId: string,
    open: boolean,
    approveGuests = true
): Promise<string | null> {
    const meeting = await prisma.meeting.findUnique({
        where: { id: meetingId },
        select: { hostId: true, guestToken: true }
    });
    if (!meeting || meeting.hostId !== actor.id) {
        throw new ChatAccessError("Only whoever started the call can share it");
    }

    const token = open ? (meeting.guestToken ?? randomBytes(24).toString("base64url")) : null;
    await prisma.meeting.update({
        where: { id: meetingId },
        data: { guestToken: token, approveGuests }
    });
    return token;
}

/**
 * The call as the screen draws it. `seat` proves the reader is in it.
 *
 * Somebody in the lobby is *at* the call rather than in it, and gets back their
 * own admission and nothing else: not the roster, not the guest link, not who
 * else is here. The stream withholds the same things from the same seat, and a
 * screen that polls must not be the way around it.
 */
export async function readMeeting(seat: {
    meetingId: string;
    participantId: string;
}): Promise<MeetingView | null> {
    const seated = await requireSeated(seat);
    // Reading the call is a browser saying it is still there, which is the only
    // thing somebody waiting at the door does - without it they are swept out of
    // the lobby before anybody has had a chance to let them in.
    await keepSeat(seat);
    await sweep(seat.meetingId);

    if (seated.admission !== "admitted") {
        const meeting = await prisma.meeting.findUnique({
            where: { id: seat.meetingId },
            select: {
                id: true,
                title: true,
                startedAt: true,
                endedAt: true,
                channelId: true,
                scheduledAt: true
            }
        });
        if (!meeting) return null;
        return {
            id: meeting.id,
            channelId: null,
            hostId: "",
            title: meeting.title,
            startedAt: meeting.startedAt.toISOString(),
            ended: meeting.endedAt !== null,
            guestToken: null,
            approveGuests: true,
            requireAccount: false,
            scheduledAt: meeting.scheduledAt?.toISOString() ?? null,
            standalone: meeting.channelId === null,
            participants: [
                {
                    id: seated.id,
                    userId: seated.userId,
                    name: seated.name,
                    admission: seated.admission,
                    guest: seated.userId === null,
                    joinedAt: seated.joinedAt.toISOString()
                }
            ]
        };
    }

    const meeting = await prisma.meeting.findUnique({
        where: { id: seat.meetingId },
        select: {
            id: true,
            channelId: true,
            hostId: true,
            title: true,
            startedAt: true,
            endedAt: true,
            guestToken: true,
            approveGuests: true,
            requireAccount: true,
            scheduledAt: true,
            participants: {
                where: { leftAt: null, admission: { not: "denied" } },
                orderBy: { joinedAt: "asc" },
                select: {
                    id: true,
                    userId: true,
                    name: true,
                    admission: true,
                    joinedAt: true
                }
            }
        }
    });
    if (!meeting) return null;

    return {
        id: meeting.id,
        channelId: meeting.channelId,
        hostId: meeting.hostId,
        title: meeting.title,
        startedAt: meeting.startedAt.toISOString(),
        ended: meeting.endedAt !== null,
        guestToken: meeting.guestToken,
        approveGuests: meeting.approveGuests,
        requireAccount: meeting.requireAccount,
        scheduledAt: meeting.scheduledAt?.toISOString() ?? null,
        standalone: meeting.channelId === null,
        participants: meeting.participants.map((row) => ({
            id: row.id,
            userId: row.userId,
            name: row.name,
            admission: row.admission as MeetingParticipantView["admission"],
            guest: row.userId === null,
            joinedAt: row.joinedAt.toISOString()
        }))
    };
}

/** The call running in a conversation, if there is one, so the header can say
 *  so without anybody having to join to find out. */
export async function liveIn(channelId: string): Promise<{ id: string; count: number } | null> {
    const meeting = await prisma.meeting.findFirst({
        where: { channelId, endedAt: null },
        select: { id: true }
    });
    if (!meeting) return null;
    await sweep(meeting.id);

    const count = await prisma.meetingParticipant.count({
        where: { meetingId: meeting.id, leftAt: null, admission: "admitted" }
    });
    if (count === 0) {
        await closeMeeting(meeting.id);
        return null;
    }
    return { id: meeting.id, count };
}

/** Somebody sitting in a voice room, as the rail draws them. The seat and the
 *  account are both here: the seat is what makes the row unique, the account is
 *  whose face goes beside it, and a guest has only the first. */
export interface VoicePresence {
    readonly id: string;
    readonly name: string;
    readonly userId: string | null;
}

/**
 * Who is sitting in each voice channel of a space.
 *
 * The rail draws names under a voice room the way every client does, because a
 * count on its own does not answer the question anybody is asking - which is not
 * "how many" but "is anyone I want to talk to in there".
 *
 * One query for the whole space rather than one per channel. Channels the reader
 * cannot reach are left out by the caller, which resolved them already.
 */
export async function voicePresence(
    channelIds: readonly string[]
): Promise<Map<string, VoicePresence[]>> {
    if (channelIds.length === 0) return new Map();

    const meetings = await prisma.meeting.findMany({
        where: { channelId: { in: [...channelIds] }, endedAt: null },
        select: {
            channelId: true,
            participants: {
                where: {
                    leftAt: null,
                    admission: "admitted",
                    // Swept here rather than by a write: a browser that stopped
                    // saying it was there would otherwise sit in the rail as a
                    // name in a room nobody is in.
                    lastSeenAt: { gte: new Date(Date.now() - PARTICIPANT_TTL_MS) }
                },
                orderBy: { joinedAt: "asc" },
                select: { id: true, name: true, userId: true }
            }
        }
    });

    const byChannel = new Map<string, VoicePresence[]>();
    for (const meeting of meetings) {
        if (!meeting.channelId || meeting.participants.length === 0) continue;
        byChannel.set(meeting.channelId, meeting.participants);
    }
    return byChannel;
}

/** Resolve a guest's cookie into their seat, or null when it names nothing. */
export async function seatForGuestKey(guestKey: string): Promise<MeetingSeat | null> {
    const participant = await prisma.meetingParticipant.findUnique({
        where: { guestKey },
        select: { id: true, meetingId: true, admission: true, leftAt: true }
    });
    if (!participant || participant.leftAt) return null;
    return {
        meetingId: participant.meetingId,
        participantId: participant.id,
        admission: participant.admission as MeetingSeat["admission"]
    };
}

/** Resolve an account's seat in a meeting they say they are in. */
export async function seatForUser(userId: string, meetingId: string): Promise<MeetingSeat | null> {
    const participant = await prisma.meetingParticipant.findFirst({
        where: { meetingId, userId, leftAt: null },
        orderBy: { joinedAt: "desc" },
        select: { id: true, admission: true }
    });
    if (!participant) return null;
    return {
        meetingId,
        participantId: participant.id,
        admission: participant.admission as MeetingSeat["admission"]
    };
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/** One row per person per call. Rejoining after a drop reuses the seat rather
 *  than adding a second face with the same name to the room. */
async function seatFor(
    meetingId: string,
    userId: string,
    name: string,
    /** Where a *new* seat starts. Admitted everywhere a conversation decided who
     *  may be in the room; at the door for a meeting of its own, whose host
     *  asked to see who turns up. Never applied to a seat that already exists -
     *  somebody in the room does not go back to the lobby by reloading. */
    options?: { admission: MeetingSeat["admission"] }
): Promise<MeetingSeat> {
    const existing = await prisma.meetingParticipant.findFirst({
        where: { meetingId, userId, leftAt: null },
        select: { id: true, admission: true }
    });
    if (existing) {
        await prisma.meetingParticipant.update({
            where: { id: existing.id },
            data: { lastSeenAt: new Date() }
        });
        return {
            meetingId,
            participantId: existing.id,
            admission: existing.admission as MeetingSeat["admission"]
        };
    }

    const admission = options?.admission ?? "admitted";
    // Only what would take a place in the room. Somebody waiting at the door is
    // not in it, and a full call must still let people knock - the host decides
    // who comes in as somebody else leaves.
    if (admission === "admitted") await requireRoom(meetingId);
    const participant = await prisma.meetingParticipant.create({
        data: { meetingId, userId, name, admission },
        select: { id: true }
    });
    publishMeetingEvent({ meetingId, kind: "roster" });
    return { meetingId, participantId: participant.id, admission };
}

/** Refuse a join that would take the call past what a mesh can carry. */
async function requireRoom(meetingId: string): Promise<void> {
    await sweep(meetingId);
    if ((await admittedCount(meetingId)) >= MAX_IN_CALL) {
        throw new ChatAccessError("That call is full");
    }
}

/** How many browsers are in the room right now. */
async function admittedCount(meetingId: string): Promise<number> {
    return prisma.meetingParticipant.count({
        where: { meetingId, leftAt: null, admission: "admitted" }
    });
}

/**
 * Tell the conversation what its call is doing.
 *
 * A call starts, grows, shrinks and ends without a single message being posted,
 * so the only screens that ever knew were the ones inside it. Everybody else
 * kept whatever count they happened to read when they opened the conversation -
 * which is how one tab said one, another said two, and a reload said neither.
 *
 * Sent on the ordinary chat channel rather than the call's own, because the
 * audience is exactly the people who are *not* in the call.
 */
async function announceCall(
    meetingId: string,
    state: CallState,
    actorId: string,
    actorName?: string
): Promise<void> {
    const meeting = await prisma.meeting.findUnique({
        where: { id: meetingId },
        select: { channelId: true }
    });
    if (!meeting?.channelId) return;
    publishChatChange({
        channelId: meeting.channelId,
        kind: "call",
        actorId,
        actorName,
        call: { meetingId, state, count: state === "ended" ? 0 : await admittedCount(meetingId) }
    });
}

/** The caller's own row, which is both the proof and the answer to "what am I
 *  allowed to see" - so it is returned rather than thrown away. */
async function requireSeated(seat: { meetingId: string; participantId: string }): Promise<{
    id: string;
    userId: string | null;
    name: string;
    admission: MeetingSeat["admission"];
    joinedAt: Date;
}> {
    const participant = await prisma.meetingParticipant.findFirst({
        where: { id: seat.participantId, meetingId: seat.meetingId, leftAt: null },
        select: { id: true, userId: true, name: true, admission: true, joinedAt: true }
    });
    if (!participant) throw new ChatAccessError("You are not in that call");
    return { ...participant, admission: participant.admission as MeetingSeat["admission"] };
}

/** The id of the call running in a conversation, starting it if there is none.
 *
 * The create can lose a race with another tab pressing the same button, and the
 * unique `liveKey` is what makes that recoverable rather than a second room:
 * the loser reads back the one the winner made and walks into it. */
async function liveMeetingId(actor: ChatActor, channelId: string): Promise<string> {
    const running = await prisma.meeting.findFirst({
        where: { channelId, endedAt: null },
        select: { id: true }
    });
    if (running) return running.id;

    try {
        const created = await prisma.meeting.create({
            data: { channelId, hostId: actor.id, liveKey: channelId },
            select: { id: true }
        });
        return created.id;
    } catch (caught) {
        if (!isUniqueViolation(caught)) throw caught;
        const raced = await prisma.meeting.findUnique({
            where: { liveKey: channelId },
            select: { id: true }
        });
        if (!raced) throw caught;
        return raced.id;
    }
}

function isUniqueViolation(caught: unknown): boolean {
    return (
        typeof caught === "object" &&
        caught !== null &&
        (caught as Prisma.PrismaClientKnownRequestError).code === "P2002"
    );
}

/** Drop anybody whose browser stopped saying it was there. */
/**
 * When this process started serving.
 *
 * Not a fact about any call, and it belongs here all the same: it is the only
 * thing that separates a browser that went quiet from a server that was not
 * there to hear it.
 */
const SERVING_SINCE = Date.now();

/**
 * Let go of anybody whose browser stopped saying it was there.
 *
 * With one exception, and it is the difference between a deployment that can be
 * updated while people are using it and one that cannot. An update rolls this
 * process over; a host reboots; a container is replaced. For however long that
 * takes, every browser in every call goes quiet - not because anybody left, but
 * because there was nothing listening. Swept on the first request afterwards,
 * that silence empties every room in the deployment at once: the calls in them
 * are closed for being empty, and what each person sees is their call dropping
 * for no reason they can name, seconds after an update they were told was
 * seamless.
 *
 * So a process that has only just started gives the rooms the same window it
 * gives a browser before it believes silence. Anybody genuinely gone is swept
 * one window later, which costs a stale name in a roster for half a minute -
 * against ending every live call in the instance, that is not a close call.
 */
async function sweep(meetingId: string): Promise<void> {
    if (Date.now() - SERVING_SINCE < PARTICIPANT_TTL_MS) return;
    await prisma.meetingParticipant.updateMany({
        where: {
            meetingId,
            leftAt: null,
            lastSeenAt: { lt: new Date(Date.now() - PARTICIPANT_TTL_MS) }
        },
        data: { leftAt: new Date() }
    });
}

/**
 * End a one-to-one call somebody has been sitting in on their own.
 *
 * "On their own since" is worked out rather than stored: it is the moment the
 * last other person left, or the moment the call started when nobody ever
 * answered. A column would be a second copy of a fact these rows already carry,
 * and one that has to be kept right on every join and every sweep.
 */
async function endIfAlone(meetingId: string): Promise<void> {
    const meeting = await prisma.meeting.findUnique({
        where: { id: meetingId },
        select: {
            endedAt: true,
            startedAt: true,
            channel: { select: { kind: true } }
        }
    });
    if (!meeting || meeting.endedAt) return;
    if (meeting.channel?.kind !== "dm") return;

    // Nobody at all is `endIfEmpty`'s job, and two people is a call.
    if ((await admittedCount(meetingId)) !== 1) return;

    const lastOut = await prisma.meetingParticipant.findFirst({
        where: { meetingId, leftAt: { not: null } },
        orderBy: { leftAt: "desc" },
        select: { leftAt: true }
    });
    const since = lastOut?.leftAt ?? meeting.startedAt;
    if (Date.now() - since.getTime() < ALONE_TTL_MS) return;

    await closeMeeting(meetingId);
}

/**
 * The last person out of a *call* turns the lights off.
 *
 * Not of a meeting. A room somebody created on purpose, put in the diary and
 * sent an address for is not over because it is momentarily empty: the host who
 * arrives early and steps out again would take it away with them, and the link
 * they sent last week would stop opening anything. That one ends when the host
 * ends it.
 */
async function endIfEmpty(meetingId: string): Promise<void> {
    if ((await admittedCount(meetingId)) > 0) return;
    const meeting = await prisma.meeting.findUnique({
        where: { id: meetingId },
        select: { channelId: true }
    });
    if (!meeting?.channelId) return;
    await closeMeeting(meetingId);
}

/** End a call and shut its door: the guest token goes with it, so a link that
 *  was forwarded cannot reopen the room later, and `liveKey` is released so the
 *  conversation can hold a call again. */
async function closeMeeting(meetingId: string): Promise<void> {
    // Read before the row is closed, since a closed meeting is about to be one
    // nothing can be told about.
    const stillLive = await prisma.meeting.findFirst({
        where: { id: meetingId, endedAt: null },
        select: { id: true }
    });
    await prisma.$transaction([
        prisma.meeting.updateMany({
            where: { id: meetingId, endedAt: null },
            data: { endedAt: new Date(), guestToken: null, liveKey: null }
        }),
        prisma.meetingParticipant.updateMany({
            where: { meetingId, leftAt: null },
            data: { leftAt: new Date() }
        })
    ]);
    publishMeetingEvent({ meetingId, kind: "ended" });
    // Only for the one caller that actually closed it. Ending is reached from
    // several places - the last person out, a lone call timing out, the host
    // pressing the button - and each would otherwise announce it again.
    if (stillLive) await announceCall(meetingId, "ended", "");
}
// ---------------------------------------------------------------------------
// Meetings of their own
// ---------------------------------------------------------------------------

/**
 * A room that belongs to nobody's conversation.
 *
 * Everything above this line is a call inside Chat: it lives in a channel, the
 * channel decides who may be in it, and it ends when the people talking stop.
 * This is the other kind - a room somebody creates on purpose and hands an
 * address to, where half the people who turn up have no account here and never
 * will. A client, a candidate, somebody's accountant.
 *
 * Two things follow from that, and they shape everything below.
 *
 * **The link is the invitation, so it is minted with the room.** A meeting whose
 * guest link had to be opened afterwards is a meeting somebody schedules on
 * Monday, sends on Tuesday, and finds nobody could open on Wednesday.
 *
 * **Emptiness does not end it.** A conversation's call is over when the last
 * person leaves, which is right for a call and wrong for a meeting: the host who
 * joins early and steps out for a coffee would take the room with them, and the
 * address they sent last week would stop working. It ends when the host ends it.
 */

/** How many meetings a list answers with. Past this it is not a list anybody
 *  reads, and a diary that long is a diary with something wrong in it. */
const MOST_MEETINGS = 100;

/** What somebody whose account is gone is called, wherever a name is drawn from
 *  an id that no longer resolves. */
const GONE_NAME = "Somebody who has left";

export interface NewMeeting {
    readonly title: string;
    /** When it is meant to happen, or null for now. */
    readonly scheduledAt: Date | null;
    /** Whether somebody arriving on the link waits to be let in. */
    readonly approveGuests: boolean;
    /** Whether the link only opens for somebody signed in to Polaris. */
    readonly requireAccount: boolean;
}

/**
 * Create one, and mint the link that is the whole point of it.
 *
 * The permission to do this is checked where the request arrives rather than
 * here: whether this instance hands out addresses anybody at all can open is a
 * decision about the instance, and it is made once.
 */
export async function createMeeting(
    actor: ChatActor,
    input: NewMeeting
): Promise<{ meetingId: string; guestToken: string }> {
    const title = input.title.trim().slice(0, MAX_MEETING_TITLE);
    if (!title) throw new ChatAccessError("Give the meeting a name");
    if (input.scheduledAt) {
        const ahead = input.scheduledAt.getTime() - Date.now();
        if (ahead > MAX_SCHEDULE_AHEAD_MS) throw new ChatAccessError("That is too far ahead");
    }

    const guestToken = randomBytes(24).toString("base64url");
    const meeting = await prisma.meeting.create({
        data: {
            channelId: null,
            hostId: actor.id,
            title,
            guestToken,
            approveGuests: input.approveGuests,
            requireAccount: input.requireAccount,
            scheduledAt: input.scheduledAt
        },
        select: { id: true }
    });
    return { meetingId: meeting.id, guestToken };
}

/**
 * Join a meeting as an account.
 *
 * The host and anybody convened walk straight in - being asked by name is the
 * approval - and everybody else knocks, when the host asked to approve people.
 * An account is not a lesser guest here: somebody signed in who was never
 * invited is exactly as much a stranger as somebody on a forwarded link, and the
 * host seeing them at the door is the same check.
 *
 * Somebody the host removed stays removed. It is the one thing a rejoin must not
 * undo, or being shown out of a meeting would mean nothing at all.
 */
export async function joinMeeting(
    actor: ChatActor & { name: string },
    meetingId: string
): Promise<MeetingSeat> {
    const meeting = await prisma.meeting.findUnique({
        where: { id: meetingId },
        select: {
            id: true,
            channelId: true,
            endedAt: true,
            hostId: true,
            approveGuests: true,
            invites: { where: { userId: actor.id }, select: { id: true } }
        }
    });
    if (!meeting || meeting.endedAt) throw new ChatAccessError("That meeting has ended");
    // A conversation's call is reached through the conversation, which is what
    // decides who may be in it. Sending one through here would be a way past it.
    if (meeting.channelId) return join(actor, meetingId);

    const shown = await prisma.meetingParticipant.findFirst({
        where: { meetingId, userId: actor.id, admission: "denied" },
        select: { id: true }
    });
    if (shown) throw new ChatAccessError("You were removed from this meeting");

    const known = meeting.hostId === actor.id || meeting.invites.length > 0;
    return seatFor(meetingId, actor.id, actor.name, {
        admission: known || !meeting.approveGuests ? "admitted" : "waiting"
    });
}

/**
 * Join on the link, as an account.
 *
 * The case this exists for is a meeting whose host asked for accounts. Its link
 * is still the invitation - it is how somebody knows the meeting exists and what
 * it is called - but what it opens is a seat under a real name rather than one
 * typed into a box. Without it, somebody signed in who followed the link was
 * turned away by the door the link was supposed to be the key to.
 *
 * The token is the proof they were sent it, which is the whole of what a
 * meeting link ever proves; who they are is the session's to say. Everything
 * after that is the ordinary rule - the host and anybody convened walk in, a
 * stranger knocks, and somebody who was removed stays removed.
 */
export async function joinOnLink(
    actor: ChatActor & { name: string },
    token: string
): Promise<MeetingSeat> {
    const meeting = await prisma.meeting.findUnique({
        where: { guestToken: token },
        select: { id: true, endedAt: true }
    });
    if (!meeting || meeting.endedAt) throw new ChatAccessError("That meeting has ended");
    return joinMeeting(actor, meeting.id);
}

/**
 * The meetings this account has any business seeing.
 *
 * Theirs, and the ones they were asked to. Not "every meeting running", which
 * would be a list of who is talking to whom - a meeting is a room, not a
 * directory.
 */
export async function listMeetings(actor: ChatActor): Promise<MeetingSummary[]> {
    const rows = await prisma.meeting.findMany({
        where: {
            channelId: null,
            endedAt: null,
            OR: [{ hostId: actor.id }, { invites: { some: { userId: actor.id } } }]
        },
        orderBy: [{ scheduledAt: "asc" }, { createdAt: "desc" }],
        take: MOST_MEETINGS,
        select: {
            id: true,
            hostId: true,
            title: true,
            guestToken: true,
            requireAccount: true,
            approveGuests: true,
            scheduledAt: true,
            startedAt: true,
            invites: { select: { userId: true } },
            participants: {
                where: {
                    leftAt: null,
                    admission: "admitted",
                    lastSeenAt: { gte: new Date(Date.now() - PARTICIPANT_TTL_MS) }
                },
                select: { id: true }
            }
        }
    });

    // One query for every name on the list rather than one per row: a host and a
    // dozen invitations across ten meetings is otherwise a hundred lookups.
    const wanted = new Set<string>();
    for (const row of rows) {
        wanted.add(row.hostId);
        for (const invite of row.invites) wanted.add(invite.userId);
    }
    const people = await prisma.user.findMany({
        where: { id: { in: [...wanted] } },
        select: { id: true, name: true }
    });
    const named = new Map(people.map((person) => [person.id, person.name]));

    return rows.map((row) => ({
        id: row.id,
        title: row.title,
        hostId: row.hostId,
        hostName: named.get(row.hostId) ?? GONE_NAME,
        scheduledAt: row.scheduledAt?.toISOString() ?? null,
        startedAt: row.startedAt.toISOString(),
        present: row.participants.length,
        // The credential, and it goes to the host alone. Everybody else on this
        // list was asked by name and gets in as themselves.
        guestToken: row.hostId === actor.id ? row.guestToken : null,
        requireAccount: row.requireAccount,
        approveGuests: row.approveGuests,
        mine: row.hostId === actor.id,
        invited: row.invites.map((invite) => ({
            id: invite.userId,
            name: named.get(invite.userId) ?? GONE_NAME
        }))
    }));
}

/**
 * Convene people who do have accounts.
 *
 * An invitation is not a seat and not a permission - it is a record that they
 * were asked, which is what puts the meeting on their own list and lets them
 * walk in without knocking. Taking one away does not remove somebody already in
 * the room; that is what removing them is for.
 */
export async function inviteToMeeting(
    actor: ChatActor,
    meetingId: string,
    userIds: readonly string[]
): Promise<{ title: string; invited: readonly string[] }> {
    const meeting = await requireHost(actor, meetingId);
    const wanted = [...new Set(userIds)].filter((id) => id !== actor.id);
    if (wanted.length === 0) throw new ChatAccessError("Pick somebody to invite");

    // Only people who exist, so a bad id is a name that is not added rather than
    // an invitation to nobody sitting on the meeting forever.
    const real = await prisma.user.findMany({
        where: { id: { in: wanted } },
        select: { id: true }
    });
    if (real.length === 0) throw new ChatAccessError("Pick somebody to invite");

    await prisma.meetingInvite.createMany({
        data: real.map((person) => ({ meetingId, userId: person.id, invitedById: actor.id })),
        skipDuplicates: true
    });
    return { title: meeting.title, invited: real.map((person) => person.id) };
}

/** Take back an invitation. Somebody already in the room stays in it - being
 *  asked and being here are different facts, and this is only the first. */
export async function uninviteFromMeeting(
    actor: ChatActor,
    meetingId: string,
    userId: string
): Promise<void> {
    await requireHost(actor, meetingId);
    await prisma.meetingInvite.deleteMany({ where: { meetingId, userId } });
}

/**
 * Hand the meeting over.
 *
 * To somebody with an account and nobody else. The host can end the room, open
 * and close its door and show people out; a guest is somebody who typed a name
 * into a link ten seconds ago, and handing them that is handing it to whoever is
 * holding a forwarded address.
 */
export async function transferHost(
    actor: ChatActor,
    meetingId: string,
    participantId: string
): Promise<void> {
    await requireHost(actor, meetingId);
    const target = await prisma.meetingParticipant.findFirst({
        where: { id: participantId, meetingId, leftAt: null, admission: "admitted" },
        select: { userId: true }
    });
    if (!target) throw new ChatAccessError("They are not in this meeting");
    if (!target.userId) {
        throw new ChatAccessError("Only somebody with a Polaris account can host a meeting");
    }

    await prisma.meeting.update({ where: { id: meetingId }, data: { hostId: target.userId } });
    publishMeetingEvent({ meetingId, kind: "roster" });
}

/**
 * Show somebody out.
 *
 * Their seat is closed and marked refused rather than merely emptied, and that
 * difference is the whole of it: an emptied seat is what leaving looks like, and
 * anybody who left may walk back in. Refused, their browser loses the room on
 * its next breath - the stream is a seat it no longer holds - and a rejoin under
 * the same account is turned away at the door.
 *
 * A guest can come back on the link under another name. That is true of every
 * meeting link ever made, and the answer to it is the lobby: with approval on,
 * what they come back to is the door.
 */
export async function removeFromMeeting(
    actor: ChatActor,
    meetingId: string,
    participantId: string
): Promise<void> {
    const meeting = await requireHost(actor, meetingId);
    const target = await prisma.meetingParticipant.findFirst({
        where: { id: participantId, meetingId, leftAt: null },
        select: { id: true, userId: true }
    });
    if (!target) throw new ChatAccessError("They are not in this meeting");
    if (target.userId && target.userId === meeting.hostId) {
        throw new ChatAccessError("You cannot remove yourself from your own meeting");
    }

    await prisma.meetingParticipant.update({
        where: { id: target.id },
        data: { admission: "denied", leftAt: new Date() }
    });
    publishMeetingEvent({ meetingId, kind: "roster" });
}

/** What the host may change about a meeting while it stands. */
export interface MeetingOptions {
    readonly title?: string;
    readonly scheduledAt?: Date | null;
    readonly approveGuests?: boolean;
    readonly requireAccount?: boolean;
}

export async function setMeetingOptions(
    actor: ChatActor,
    meetingId: string,
    options: MeetingOptions
): Promise<void> {
    await requireHost(actor, meetingId);
    const title = options.title?.trim().slice(0, MAX_MEETING_TITLE);
    if (options.title !== undefined && !title) throw new ChatAccessError("Give the meeting a name");

    await prisma.meeting.update({
        where: { id: meetingId },
        data: {
            ...(title ? { title } : {}),
            ...(options.scheduledAt !== undefined ? { scheduledAt: options.scheduledAt } : {}),
            ...(options.approveGuests !== undefined
                ? { approveGuests: options.approveGuests }
                : {}),
            ...(options.requireAccount !== undefined
                ? { requireAccount: options.requireAccount }
                : {})
        }
    });
    publishMeetingEvent({ meetingId, kind: "roster" });
}

/** End a meeting, with the same door-shutting every other ending does: the link
 *  stops opening anything. */
export async function endMeeting(actor: ChatActor, meetingId: string): Promise<void> {
    await requireHost(actor, meetingId);
    await closeMeeting(meetingId);
}

/** Whoever is asking must be the host, and the meeting must still be standing. */
async function requireHost(
    actor: ChatActor,
    meetingId: string
): Promise<{ title: string; hostId: string }> {
    const meeting = await prisma.meeting.findUnique({
        where: { id: meetingId },
        select: { hostId: true, title: true, endedAt: true }
    });
    if (!meeting || meeting.endedAt) throw new ChatAccessError("That meeting has ended");
    if (meeting.hostId !== actor.id) {
        throw new ChatAccessError("Only whoever is hosting the meeting can do that");
    }
    return { title: meeting.title, hostId: meeting.hostId };
}

// ---------------------------------------------------------------------------
// What the room says to itself
// ---------------------------------------------------------------------------

/**
 * The chat inside a call.
 *
 * Its own table rather than the conversation's, and it has to be: every message
 * in Chat is written by an account against a channel somebody is a member of,
 * and neither is true of a guest who typed a name into a link ten seconds ago.
 * So a line here belongs to a *seat*, which is the only identity a meeting can
 * promise for everybody in it, and it goes when the meeting goes.
 *
 * It is where a link, an address or a name gets dropped while people are
 * talking, which is the one thing a call cannot do out loud.
 */
export interface MeetingLine {
    readonly id: string;
    /** The seat that said it, so a screen can tell its own lines apart. */
    readonly participantId: string;
    readonly name: string;
    readonly guest: boolean;
    readonly body: string;
    readonly at: string;
}

/** Say something to the room. Only somebody actually in it: the lobby is not a
 *  place to be heard from. */
export async function sayInMeeting(
    seat: { meetingId: string; participantId: string },
    body: string
): Promise<void> {
    const seated = await requireSeated(seat);
    if (seated.admission !== "admitted") {
        throw new ChatAccessError("You are still waiting to be let in");
    }
    const said = body.trim().slice(0, MAX_MEETING_LINE);
    if (!said) throw new ChatAccessError("Write something first");

    await prisma.meetingMessage.create({
        data: { meetingId: seat.meetingId, participantId: seat.participantId, body: said }
    });
    publishMeetingEvent({ meetingId: seat.meetingId, kind: "said" });
}

/** What the room has said. The name comes off the seat that said it, so a guest
 *  is named the way they named themselves and nobody has to have an account. */
export async function saidInMeeting(seat: {
    meetingId: string;
    participantId: string;
}): Promise<readonly MeetingLine[]> {
    const seated = await requireSeated(seat);
    if (seated.admission !== "admitted") return [];

    const rows = await prisma.meetingMessage.findMany({
        where: { meetingId: seat.meetingId },
        orderBy: { createdAt: "desc" },
        take: MEETING_LINES,
        select: {
            id: true,
            participantId: true,
            body: true,
            createdAt: true,
            participant: { select: { name: true, userId: true } }
        }
    });

    return rows.reverse().map((row) => ({
        id: row.id,
        participantId: row.participantId,
        name: row.participant.name,
        guest: row.participant.userId === null,
        body: row.body,
        at: row.createdAt.toISOString()
    }));
}
