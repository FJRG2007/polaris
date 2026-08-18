/**
 * Whether somebody is here, and whether they are on a call you could join.
 *
 * Two facts about a person that every screen showing their face wants and none
 * of them can afford to ask for one at a time. So they are asked in batches, by
 * a store in the browser that collects the ids on screen and comes back once.
 *
 * **What decides the answer.** A chosen status wins: do not disturb, away, or
 * invisible are things somebody said, and a green dot over the top of "do not
 * disturb" would make the setting a lie. `auto` - what almost everybody has
 * almost always - is worked out from the freshest session: here a moment ago is
 * online, here within the quarter hour is idle, and anything older is offline.
 *
 * **Invisible is offline.** Not "invisible" - there is no such colour to draw,
 * and a state that renders differently is a state that gives itself away. The
 * person themselves is told the truth, because a setting nobody can see the
 * effect of is a setting nobody trusts.
 *
 * **Privacy applies.** Being able to see somebody's face is not being able to
 * see whether they are at their desk: `lastSeen` is a per-account setting, and
 * somebody who has turned it off reads as offline to everybody it is off for.
 * An administrator sees through it, as they do everywhere else.
 */

import { prisma } from "@polaris/db";
import { allowedBy } from "@/lib/privacy-service";
import { reachableChannelIds } from "@/lib/chat/access";
import { PARTICIPANT_TTL_MS } from "@/lib/chat/meetings";
import { PRESENCE_CHOICES, type Presence, type PresenceChoice } from "@polaris/core";

// The vocabulary lives in core, because the picker that sets it is a client
// component and this file reaches for Prisma the moment it is imported.
/**
 * How recently a session has to have been seen to count as being at the screen.
 *
 * A session records activity at most once a minute, so anything under two would
 * flicker off between two writes for somebody who never left.
 */
const ONLINE_MS = 3 * 60_000;

/** And how long after that they are "idle" rather than gone. A quarter of an
 *  hour, which is lunch rather than a laptop closed for the night. */
const IDLE_MS = 15 * 60_000;

export interface PresenceView {
    readonly status: Presence;
    /** The conversation of a call they are in, when the reader could walk into
     *  it too. Null when they are not in one, and null when they are in one the
     *  reader cannot reach - which is the same answer, because a call somebody
     *  cannot join is not news they can act on. */
    readonly inCall: string | null;
}

/**
 * Where each of these people is, as this reader may see it.
 *
 * @param viewer - Who is asking. Their own entry is always the truth, including
 *   an invisible they chose themselves.
 */
export async function presenceFor(
    viewer: { id: string; isAdmin: boolean },
    ids: readonly string[]
): Promise<Map<string, PresenceView>> {
    const wanted = [...new Set(ids.filter(Boolean))];
    if (wanted.length === 0) return new Map();

    const [people, sessions, calls, visible] = await Promise.all([
        prisma.user.findMany({
            where: { id: { in: wanted } },
            select: { id: true, presence: true, presenceUntil: true }
        }),
        // The freshest session per account, from one query rather than one each:
        // ordering and taking the first per id in memory is cheaper than a
        // correlated subquery for a page of thirty faces.
        prisma.sessionState.findMany({
            where: { userId: { in: wanted } },
            orderBy: { lastSeenAt: "desc" },
            select: { userId: true, lastSeenAt: true }
        }),
        callsFor(viewer, wanted),
        // Asked about the whole page at once rather than once per face: the
        // privacy check is a row read and a rule, and thirty of them one at a
        // time is thirty queries for one avatar strip.
        allowedBy(viewer, "lastSeen", wanted)
    ]);

    const seen = new Map<string, Date>();
    for (const session of sessions) {
        if (!seen.has(session.userId)) seen.set(session.userId, session.lastSeenAt);
    }

    const now = Date.now();
    const answer = new Map<string, PresenceView>();
    for (const person of people) {
        const mine = person.id === viewer.id;
        const inCall = calls.get(person.id) ?? null;
        if (!mine && !visible.has(person.id)) {
            // Not "unknown": there is no third colour, and a dot that is absent
            // for some people and grey for others says which is which.
            answer.set(person.id, { status: "offline", inCall });
            continue;
        }
        answer.set(person.id, {
            status: statusOf(
                inForce(person.presence, person.presenceUntil, now),
                seen.get(person.id),
                now
            ),
            inCall
        });
    }
    return answer;
}

/** One person's own, for the picker that sets it, with the moment it lapses. */
export interface PresenceChoiceView {
    readonly choice: PresenceChoice;
    /** When it goes back to `auto`, or null for "until I change it". Null too
     *  for a choice that has already lapsed, which reads as `auto`. */
    readonly until: string | null;
}

export async function presenceChoiceOf(userId: string): Promise<PresenceChoiceView> {
    const row = await prisma.user.findUnique({
        where: { id: userId },
        select: { presence: true, presenceUntil: true }
    });
    if (!row) return { choice: "auto", until: null };

    const held = inForce(row.presence, row.presenceUntil, Date.now());
    // Tidied on the way past rather than by anything that runs on a schedule.
    // This is the account's own screen, so it is one write, at the one moment
    // somebody is looking at the thing that would otherwise be a lie.
    if (row.presenceUntil && held === "auto") {
        await prisma.user.update({
            where: { id: userId },
            data: { presence: "auto", presenceUntil: null }
        });
        return { choice: "auto", until: null };
    }
    return {
        choice: held,
        until: held === "auto" ? null : (row.presenceUntil?.toISOString() ?? null)
    };
}

/**
 * Say what to appear as, and for how long.
 *
 * `minutes` null is "until I change it", which is what a status was before there
 * was a window - so the old behaviour is still one of the options rather than
 * something that was taken away. Going back to `auto` clears the window with it:
 * a lapse time on "work it out from whether I am here" would be a rule about
 * nothing.
 */
export async function setPresenceChoice(
    userId: string,
    choice: PresenceChoice,
    minutes: number | null = null
): Promise<void> {
    const until =
        choice === "auto" || minutes === null ? null : new Date(Date.now() + minutes * 60_000);
    await prisma.user.update({
        where: { id: userId },
        data: { presence: choice, presenceUntil: until }
    });
}

/** What a stored choice actually is now. A window that has passed is not a
 *  choice: the account is back on `auto`, whatever the column still says. */
function inForce(chosen: string, until: Date | null, now: number): PresenceChoice {
    if (!(PRESENCE_CHOICES as readonly string[]).includes(chosen)) return "auto";
    if (until && until.getTime() <= now) return "auto";
    return chosen as PresenceChoice;
}

/** The rule, on its own so it can be read in one place. */
function statusOf(chosen: string, lastSeen: Date | undefined, now: number): Presence {
    if (chosen === "busy") return "busy";
    if (chosen === "away") return "idle";
    // Invisible is offline to everybody, the account's own screen included.
    //
    // It used to draw itself as idle to the person who chose it, on the
    // reasoning that they are plainly here and reading this. What that actually
    // did was answer the only question they were asking - "am I hidden?" - with
    // the amber dot that means away, which is a state they did not pick and
    // which the picker right above it draws in grey. Somebody who sets
    // themselves invisible and then sees the away dot has been told they are
    // not invisible.
    if (chosen === "invisible") return "offline";

    if (!lastSeen) return "offline";
    const since = now - lastSeen.getTime();
    if (since < ONLINE_MS) return "online";
    if (since < IDLE_MS) return "idle";
    return "offline";
}

/**
 * Who of these is on a call the reader could walk into.
 *
 * The reader's own reach decides, which is what makes this safe to draw beside a
 * face anywhere in Polaris: a call in a conversation they are not in is not
 * mentioned at all, rather than mentioned and refused.
 */
async function callsFor(
    viewer: { id: string },
    ids: readonly string[]
): Promise<Map<string, string>> {
    const seats = await prisma.meetingParticipant.findMany({
        where: {
            userId: { in: [...ids] },
            leftAt: null,
            admission: "admitted",
            // A browser that closed without saying so leaves its seat behind, so
            // a seat nobody has refreshed is not somebody on a call.
            lastSeenAt: { gt: new Date(Date.now() - PARTICIPANT_TTL_MS) },
            meeting: { endedAt: null }
        },
        select: { userId: true, meeting: { select: { channelId: true } } }
    });
    if (seats.length === 0) return new Map();

    const reachable = await reachableChannelIds(viewer);
    const found = new Map<string, string>();
    for (const seat of seats) {
        const channelId = seat.meeting.channelId;
        if (!channelId || !reachable.has(channelId)) continue;
        if (!found.has(seat.userId!)) found.set(seat.userId!, channelId);
    }
    return found;
}
