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
import * as core from "@polaris/core";
import { allowedBy } from "@/lib/privacy-service";
import { reachableChannelIds } from "@/lib/chat/access";
import { PARTICIPANT_TTL_MS } from "@/lib/chat/meetings";
import { type Presence, type PresenceChoice } from "@polaris/core";
import { getPlatformDisplayPreferences } from "@/lib/display-prefs-service";
import { activeSchedulesFor, schedulesOf, scheduleZoneOf } from "@/lib/presence-schedule-service";

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
    /**
     * The line this person is showing, or empty when there is none to show.
     *
     * Empty for somebody who is offline, and that is the rule rather than a
     * consequence: a status is what somebody is doing now, and "back in five
     * minutes" under a grey dot is a sentence from an afternoon that has ended.
     * Empty too once its own window has passed, which is worked out here
     * because nothing sweeps them.
     *
     * Withheld from anybody the account does not show its presence to, for free:
     * they are handed `offline`, and offline carries no line.
     */
    readonly note: string;
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

    const [people, sessions, calls, visible, schedules, platformPrefs] = await Promise.all([
        prisma.user.findMany({
            where: { id: { in: wanted } },
            select: {
                id: true,
                presence: true,
                presenceUntil: true,
                presenceSetAt: true,
                statusText: true,
                statusUntil: true,
                // Only ever read for the timezone, and only for somebody who has
                // a schedule: a window written as 00:00 is midnight on their
                // clock, and the server has none to fall back on.
                displayPrefs: true
            }
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
        allowedBy(viewer, "lastSeen", wanted),
        // The windows anybody on this page is inside. One indexed lookup that
        // finds nothing for almost every account, which is the shape that makes
        // this affordable on a query that runs on every refresh.
        activeSchedulesFor(wanted),
        // Memoized per request, so this is the layout's own read almost every
        // time rather than a second one.
        getPlatformDisplayPreferences()
    ]);

    const seen = new Map<string, Date>();
    for (const session of sessions) {
        if (!seen.has(session.userId)) seen.set(session.userId, session.lastSeenAt);
    }

    const now = Date.now();
    const at = new Date(now);
    const answer = new Map<string, PresenceView>();
    for (const person of people) {
        const mine = person.id === viewer.id;
        const inCall = calls.get(person.id) ?? null;
        if (!mine && !visible.has(person.id)) {
            // Not "unknown": there is no third colour, and a dot that is absent
            // for some people and grey for others says which is which.
            answer.set(person.id, { status: "offline", note: "", inCall });
            continue;
        }
        const rules = schedules.get(person.id) ?? [];
        const held = core.presenceInForce(
            person,
            rules,
            // Worked out only for the few accounts that have a window, because
            // it means parsing a blob of preferences per person.
            rules.length > 0
                ? core.resolveDisplayPreferences(
                      platformPrefs,
                      core.parseDisplayPreferences(person.displayPrefs)
                  ).timeZone
                : core.AUTOMATIC_TIME_ZONE,
            at
        );
        const status = statusOf(held.choice, seen.get(person.id), now);
        answer.set(person.id, {
            status,
            // Only while they are actually here. Both halves matter: a status
            // whose window has passed is not a status, and one under a grey dot
            // is a note from a day that is over.
            note:
                status !== "offline" && core.statusInForce(person, new Date(now))
                    ? person.statusText.trim()
                    : "",
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
    /** Whether a status schedule is what is holding it, rather than something
     *  this person pressed. The picker says so beside the tick: somebody who
     *  does not recognize a state they are apparently in should be told where it
     *  came from, not left to hunt for the setting that did it. */
    readonly scheduled: boolean;
    /** The next moment this answer stops being the answer - a window lapsing, a
     *  window opening - or null when nothing is due. Said here because the
     *  screen holding it renders once and cannot work out an opening for
     *  itself: it is the account's rules, on the account's clock. */
    readonly nextChangeAt: string | null;
}

export async function presenceChoiceOf(userId: string): Promise<PresenceChoiceView> {
    const [row, rules, timeZone] = await Promise.all([
        prisma.user.findUnique({
            where: { id: userId },
            select: { presence: true, presenceUntil: true, presenceSetAt: true }
        }),
        schedulesOf(userId),
        scheduleZoneOf(userId)
    ]);
    if (!row) return { choice: "auto", until: null, scheduled: false, nextChangeAt: null };

    const now = new Date();
    // Tidied on the way past rather than by anything that runs on a schedule.
    // This is the account's own screen, so it is one write, at the one moment
    // somebody is looking at the thing that would otherwise be a lie.
    //
    // `presenceSetAt` is deliberately left where it is: lapsing is the window
    // running out, not a new decision, so a schedule that opened after the
    // choice was made is still the schedule's to take over.
    const lapsed = Boolean(row.presenceUntil && row.presenceUntil <= now);
    if (lapsed) {
        await prisma.user.update({
            where: { id: userId },
            data: { presence: "auto", presenceUntil: null }
        });
    }

    const account = lapsed ? { ...row, presence: "auto", presenceUntil: null } : row;
    const enabled = rules.filter((rule) => rule.enabled);
    const held = core.presenceInForce(account, enabled, timeZone, now);
    const nextChange = core.nextPresenceChange(account, enabled, timeZone, now);
    return {
        choice: held.choice,
        until: held.until?.toISOString() ?? null,
        scheduled: held.scheduled,
        nextChangeAt: nextChange?.toISOString() ?? null
    };
}

/**
 * Say what to appear as, and until when.
 *
 * A window with no end is "until I change it", which is what a status was before
 * there was one at all - so the old behaviour is still one of the options rather
 * than something that was taken away. Going back to `auto` clears the window with
 * it: a lapse time on "work it out from whether I am here" would be a rule about
 * nothing.
 *
 * The moment of the choice is recorded whatever it was, `auto` included, and
 * that is the whole mechanism behind overruling a status schedule: choosing
 * anything inside an open window - being visible again at one in the morning -
 * is what makes it yours until that window closes.
 */
export async function setPresenceChoice(
    userId: string,
    choice: PresenceChoice,
    window: core.WindowChoice = {}
): Promise<void> {
    const until = choice === "auto" ? null : core.windowEndsAt(window);
    await prisma.user.update({
        where: { id: userId },
        data: { presence: choice, presenceUntil: until, presenceSetAt: new Date() }
    });
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

/**
 * One person's own status, for the picker that sets it.
 *
 * Reports it as it stands rather than as it is stored: a window that has passed
 * is no status, and showing somebody a line they set on Tuesday under a heading
 * saying it is live would be the screen lying about their own account.
 */
export interface StatusView {
    readonly text: string;
    /** When it clears, or null for "until I clear it". Null too for one that has
     *  already lapsed, which reads as no status at all. */
    readonly until: string | null;
}

export async function ownStatus(userId: string): Promise<StatusView> {
    const row = await prisma.user.findUnique({
        where: { id: userId },
        select: { statusText: true, statusUntil: true }
    });
    if (!row || !core.statusInForce(row)) return { text: "", until: null };
    return { text: row.statusText.trim(), until: row.statusUntil?.toISOString() ?? null };
}

/**
 * Set the line, and when it clears itself.
 *
 * An empty line is how one is taken off, so it clears the window with it - a
 * moment attached to nothing would be a rule about nothing. A window with no end
 * is "until I clear it", which is offered rather than assumed for the reason the
 * ladder exists at all.
 */
export async function setStatus(
    userId: string,
    text: string,
    window: core.WindowChoice
): Promise<void> {
    const line = text.trim();
    await prisma.user.update({
        where: { id: userId },
        data: {
            statusText: line,
            statusUntil: line ? core.windowEndsAt(window) : null
        }
    });
}
