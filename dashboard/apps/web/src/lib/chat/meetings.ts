/**
 * Calls.
 *
 * The media never touches Polaris. Browsers connect to each other and send audio
 * and video directly; what this server does is introduce them, hold the list of
 * who is in the room, and decide who is allowed in. That is the whole reason a
 * call can exist on a box running on somebody's shelf: relaying video for eight
 * people is a different machine, and none of it is needed for the case Polaris
 * is actually in.
 *
 * It follows that a call between people on different networks may not connect at
 * all without a STUN or TURN server configured, and this module says so rather
 * than pretending. See POLARIS_STUN_URLS and POLARIS_TURN_URL.
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

import { loadEnv } from "@polaris/config";
import { randomBytes } from "node:crypto";
import { prisma, type Prisma } from "@polaris/db";
import { publishMeetingEvent } from "./meeting-signal";
import { ChatAccessError, requireChannel, type ChatActor } from "./access";

/** How many browsers one call holds.
 *
 *  Every browser sends its own video to every other one, so eight people is
 *  fifty-six streams and a laptop fan. Past this the answer is a server that
 *  mixes the call, which Polaris deliberately does not run. */
export const MAX_IN_CALL = 8;

/** How long a participant may go quiet before they are treated as gone. Their
 *  browser refreshes this while the call is on screen; a closed laptop stops. */
export const PARTICIPANT_TTL_MS = 30_000;

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
    readonly participants: readonly MeetingParticipantView[];
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
 * The addresses a browser should try when connecting to another one.
 *
 * Read from the environment on every call rather than cached: it is two string
 * lookups, and an operator who adds a TURN server should not have to restart to
 * find out whether it helped.
 */
export function iceServers(): { urls: string[]; username?: string; credential?: string }[] {
    const env = loadEnv();
    const servers: { urls: string[]; username?: string; credential?: string }[] = [];

    const stun = env.POLARIS_STUN_URLS.split(",")
        .map((url) => url.trim())
        .filter(Boolean);
    if (stun.length) servers.push({ urls: stun });

    if (env.POLARIS_TURN_URL) {
        servers.push({
            urls: [env.POLARIS_TURN_URL],
            username: env.POLARIS_TURN_USERNAME,
            credential: env.POLARIS_TURN_PASSWORD
        });
    }
    return servers;
}

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
    return seatFor(await liveMeetingId(actor, channelId), actor.id, actor.name);
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

    return seatFor(meetingId, actor.id, actor.name);
}

/**
 * Join on a guest link.
 *
 * The token is the whole credential, so what it grants is deliberately small:
 * one room, while it runs, under a name the guest typed. With approval on - the
 * default - the seat starts in the lobby and no signalling reaches it until
 * somebody inside admits them.
 */
export async function joinAsGuest(token: string, name: string): Promise<MeetingSeat> {
    const meeting = await prisma.meeting.findUnique({
        where: { guestToken: token },
        select: { id: true, endedAt: true, approveGuests: true }
    });
    if (!meeting || meeting.endedAt) throw new ChatAccessError("That call has ended");
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

/** Still here. Called on a heartbeat from the browser showing the call. */
export async function keepSeat(seat: { meetingId: string; participantId: string }): Promise<void> {
    await prisma.meetingParticipant.updateMany({
        where: { id: seat.participantId, meetingId: seat.meetingId, leftAt: null },
        data: { lastSeenAt: new Date() }
    });
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
            select: { id: true, title: true, startedAt: true, endedAt: true }
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
async function seatFor(meetingId: string, userId: string, name: string): Promise<MeetingSeat> {
    const existing = await prisma.meetingParticipant.findFirst({
        where: { meetingId, userId, leftAt: null },
        select: { id: true }
    });
    if (existing) {
        await prisma.meetingParticipant.update({
            where: { id: existing.id },
            data: { lastSeenAt: new Date() }
        });
        return { meetingId, participantId: existing.id, admission: "admitted" };
    }

    await requireRoom(meetingId);
    const participant = await prisma.meetingParticipant.create({
        data: { meetingId, userId, name, admission: "admitted" },
        select: { id: true }
    });
    publishMeetingEvent({ meetingId, kind: "roster" });
    return { meetingId, participantId: participant.id, admission: "admitted" };
}

/** Refuse a join that would take the call past what a mesh can carry. */
async function requireRoom(meetingId: string): Promise<void> {
    await sweep(meetingId);
    const inside = await prisma.meetingParticipant.count({
        where: { meetingId, leftAt: null, admission: "admitted" }
    });
    if (inside >= MAX_IN_CALL) throw new ChatAccessError("That call is full");
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
async function sweep(meetingId: string): Promise<void> {
    await prisma.meetingParticipant.updateMany({
        where: {
            meetingId,
            leftAt: null,
            lastSeenAt: { lt: new Date(Date.now() - PARTICIPANT_TTL_MS) }
        },
        data: { leftAt: new Date() }
    });
}

async function endIfEmpty(meetingId: string): Promise<void> {
    const left = await prisma.meetingParticipant.count({
        where: { meetingId, leftAt: null, admission: "admitted" }
    });
    if (left === 0) await closeMeeting(meetingId);
}

/** End a call and shut its door: the guest token goes with it, so a link that
 *  was forwarded cannot reopen the room later, and `liveKey` is released so the
 *  conversation can hold a call again. */
async function closeMeeting(meetingId: string): Promise<void> {
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
}
