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
 * guest link live. Three minutes is long enough to step away and come back and
 * short enough that a forgotten call is not an afternoon of it.
 *
 * Only in a direct message. A channel call is a room people drop into, and the
 * first person to arrive being thrown out for being early is exactly wrong.
 */
export const ALONE_TTL_MS = 3 * 60_000;

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

/** Ring exactly these people about this call. */
async function ring(
    meetingId: string,
    channelId: string,
    actor: ChatActor & { name: string },
    audience: readonly string[]
): Promise<void> {
    publishChatChange({
        channelId,
        kind: "call",
        actorId: actor.id,
        actorName: actor.name,
        audience,
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

async function endIfEmpty(meetingId: string): Promise<void> {
    if ((await admittedCount(meetingId)) === 0) await closeMeeting(meetingId);
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
