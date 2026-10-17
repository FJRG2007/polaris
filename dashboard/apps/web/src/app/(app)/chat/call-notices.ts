/**
 * Which of the call's notices is said, and which wait behind it.
 *
 * A call has half a dozen things it can say about itself - the call server gone,
 * a microphone not being sent, a microphone picking nothing up, a voice too
 * quiet, a thin line, a share that stopped moving - and each was drawn as a
 * banner of its own. When the connection to the call server went, four of them
 * arrived together and took the height the pictures and the controls needed,
 * and three of the four were only that one fault seen from a different side: a
 * microphone cannot be sent, or heard, through a connection that is not there.
 *
 * So every notice says what it is about (`cause`) and which other causes it
 * explains while it stands. A notice explained by another one is a consequence:
 * still reachable, folded behind the one that explains it, never a line of its
 * own. Of the rest, the most serious is the one line the call shows, and the
 * others wait behind a count.
 *
 * The dependencies are the ones `call-diagnosis` already reasons with: nothing
 * about a microphone or the far end can be judged without the call server, and
 * a microphone that is not being sent at all is not also "quiet".
 */

export type NoticeSeverity = "error" | "warning" | "info";

/**
 * What a notice is about, finely enough for one to explain another.
 *
 * - `server` - this device and the call server: lost, reconnecting.
 * - `line` - a connection that is there but thin.
 * - `mic-fault` - no microphone open, stopped, or open and not being sent.
 * - `mic-silent` - a microphone that is being sent and picks nothing up.
 * - `mic-quiet` - a voice going out well below everybody else's.
 * - `sound` - what this browser plays: everybody turned down.
 * - `far-end` - what the others send, or fail to.
 * - `share` - what this device is sharing.
 * - `other` - anything said about the call that fits none of these.
 */
export type NoticeCause =
    | "server"
    | "line"
    | "mic-fault"
    | "mic-silent"
    | "mic-quiet"
    | "sound"
    | "far-end"
    | "share"
    | "other";

export interface CallNotice {
    readonly id: string;
    readonly severity: NoticeSeverity;
    readonly cause: NoticeCause;
}

/**
 * What each cause explains while a notice about it stands.
 *
 * The call server first, because everything that is measured on a call goes
 * through it: with no connection there is no microphone being sent, nothing
 * arriving to compare a voice against, and a "slow line" that is simply no line.
 * A share is the one thing it does not explain - whether the picture being
 * shared is moving is a fact about this device.
 */
const EXPLAINS: Readonly<Record<NoticeCause, readonly NoticeCause[]>> = {
    server: ["line", "mic-fault", "mic-silent", "mic-quiet", "sound", "far-end"],
    line: [],
    "mic-fault": ["mic-silent", "mic-quiet"],
    "mic-silent": ["mic-quiet"],
    "mic-quiet": [],
    sound: [],
    "far-end": [],
    share: [],
    other: []
};

/** The causes that belong on the microphone button as well as in the strip. */
const MIC_CAUSES: ReadonlySet<NoticeCause> = new Set(["mic-fault", "mic-silent", "mic-quiet"]);

const SEVERITY_RANK: Readonly<Record<NoticeSeverity, number>> = { error: 0, warning: 1, info: 2 };

/** Between two notices equally serious, the one nearer the root goes first. */
const CAUSE_RANK: Readonly<Record<NoticeCause, number>> = {
    server: 0,
    "mic-fault": 1,
    line: 2,
    "mic-silent": 3,
    "mic-quiet": 4,
    sound: 5,
    "far-end": 6,
    other: 7,
    share: 8
};

export interface NoticeOrder<T extends CallNotice> {
    /** The one line the call shows, or null when it has nothing to say. */
    readonly top: T | null;
    /** Everything else that stands on its own, most serious first. */
    readonly rest: readonly T[];
    /** What is explained by something standing, kept so that nothing is lost. */
    readonly consequences: readonly T[];
    /** The standing notice the microphone button is marked with, if any. */
    readonly mic: T | null;
}

function before(a: CallNotice, b: CallNotice): number {
    return (
        SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
        CAUSE_RANK[a.cause] - CAUSE_RANK[b.cause]
    );
}

/** Put the call's notices in order and settle which of them are said. */
export function arbitrateNotices<T extends CallNotice>(active: readonly T[]): NoticeOrder<T> {
    const sorted = [...active].sort(before);
    const standing: T[] = [];
    const consequences: T[] = [];
    for (const notice of sorted) {
        // Explained by anything else on the list, standing or not: the graph has
        // no cycles, so whatever explains this one is itself standing or is
        // explained by something nearer the root, which is.
        const explained = sorted.some(
            (other) => other !== notice && EXPLAINS[other.cause].includes(notice.cause)
        );
        // Two notices about the same thing - the call server named by the
        // connection and by the diagnosis - are one fact said twice. The first
        // in order is the one said.
        const repeated = standing.some((other) => other.cause === notice.cause);
        (explained || repeated ? consequences : standing).push(notice);
    }
    return {
        top: standing[0] ?? null,
        rest: standing.slice(1),
        consequences,
        mic: standing.find((notice) => MIC_CAUSES.has(notice.cause)) ?? null
    };
}
