/**
 * The lines about players arriving and leaving, read in a way nothing can drown
 * and nothing has to read twice.
 *
 * The container's log is everything the server printed, and a server Polaris talks
 * to prints two lines for every command it is sent - "Thread RCON Client started",
 * "shutting down" - because each command is its own RCON connection. The last 1500
 * lines of one such server were exactly that: no join, no leave, no login address.
 * So the lines that matter are picked out of the server's own `logs/latest.log`
 * inside the container, before anything is cut.
 *
 * That file is large - 125 MB on a modded server by the evening - and is asked
 * about every few seconds while somebody watches. So it is read the way `tail -f`
 * reads it: a cursor per server remembers which file (its inode) and how far into
 * it the last read got, and each read picks out only the bytes written since. A
 * file that is a different one, or shorter than the cursor, was rotated or cut,
 * and is scanned again from a bounded distance before its end. No read ever takes
 * more than `STEP_BYTES` of it. The lines found are kept, a bounded number of
 * them, so every read still answers with the recent history and not only the
 * last few seconds of it.
 *
 * What one command hands back is cut at 16 KiB with no marker (see
 * `container-files`), so the matching lines are capped at their newest end well
 * under that. Stamps are the server's local time - Forge's dated ones and vanilla's
 * time of day - and are turned into the RFC3339 instants the container's log
 * carries, so every reader that parses that shape reads this unchanged.
 *
 * Pure: the script's text and the reading of its output. `service.ts` runs it and
 * holds the state between reads.
 */

/** The lines worth keeping: arrivals, departures, and the server starting or
 *  stopping, for Java and for Bedrock's own wording. A fixed pattern - nothing a
 *  player or an operator typed is ever part of this command. */
const WANTED =
    "logged in with entity id|joined the game|left the game|lost connection: |Starting minecraft server version|Stopping server|Player connected:|Player disconnected:";

const LATEST = "/data/logs/latest.log";

/** How far before its end a file with no usable cursor is scanned. */
export const SCAN_BYTES = 16 * 1024 * 1024;
/** The most of the file one read takes. A server that printed more than this
 *  since the last read has its oldest new bytes skipped rather than the host's
 *  disk and CPU spent on them. */
export const STEP_BYTES = 16 * 1024 * 1024;
/** How far back past the cursor each read starts, so a line that was half written
 *  when the last read stopped is read whole this time. Lines already kept are not
 *  kept twice. */
export const OVERLAP_BYTES = 1024;
/** How much of the matching lines one read hands back, newest last: under the 16
 *  KiB one command can return. */
const MATCH_BYTES = 12_000;
/** How many matching lines are kept per server between reads. */
export const KEPT_LINES = 400;

/** Where the last read of a server's log stopped. */
export interface LogCursor {
    /** Which file it was, so a rotated one is noticed. */
    readonly inode: string;
    /** How many bytes of it have been read. */
    readonly offset: number;
}

/** What is kept between reads: the cursor, and the lines found so far. */
export interface PlayerLogState {
    readonly cursor: LogCursor | null;
    /** Container-log lines (`<RFC3339> <line>`), oldest first. */
    readonly lines: readonly string[];
}

export const NO_PLAYER_LOG: PlayerLogState = { cursor: null, lines: [] };

/** A whole number the shell may be handed, or nothing. */
function count(value: number): number {
    return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

/**
 * The command, run with `sh -c` in the server's container, for a read that picks
 * up from `cursor`.
 *
 * Prints `@clock <offset> <date>`, `@stat <inode> <size> <date of last write>` and
 * `@from <byte>` - where this read began - then the matching lines of the bytes
 * from there to the size it stat'ed. Prints nothing at all for a server with no
 * `latest.log` - Bedrock writes none - which the caller reads as "use the
 * container's log instead".
 */
export function playerLogScript(cursor: LogCursor | null): string {
    const inode = cursor && /^\d+$/.test(cursor.inode) ? cursor.inode : "none";
    const offset = count(cursor?.offset ?? 0);
    return [
        `f=${LATEST}`,
        "[ -f \"$f\" ] || exit 0",
        `echo "@clock $(date +%z) $(date +%F)"`,
        `set -- $(stat -c '%i %s' "$f")`,
        `i=$1; s=$2`,
        `echo "@stat $i $s $(date -r "$f" +%F)"`,
        // The same file, and at least as long as when it was last read: pick up
        // where that left off. Anything else is a file that was rotated or cut.
        `if [ "$i" = "${inode}" ] && [ "$s" -ge ${offset} ]; then from=$((${offset} - ${OVERLAP_BYTES})); else from=$((s - ${SCAN_BYTES})); fi`,
        `[ "$from" -lt 0 ] && from=0`,
        `[ $((s - from)) -gt ${STEP_BYTES} ] && from=$((s - ${STEP_BYTES}))`,
        `echo "@from $from"`,
        `tail -c +$((from + 1)) "$f" | head -c $((s - from)) | grep -aE '${WANTED}' | tail -c ${MATCH_BYTES}`
    ].join("\n");
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** `[29Sep2026 10:15:02.123]`, which Forge and NeoForge write. */
const DATED = /^\[(\d{2})([A-Z][a-z]{2})(\d{4}) (\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?\]/;
/** `[10:15:02]` or Paper's `[10:15:02 INFO]`: the time of day alone. */
const TIMED = /^\[(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?[\] ]/;
const DAY_MS = 24 * 60 * 60 * 1000;

/** `+0200` as minutes east of UTC, or null for anything else. */
function offsetMinutes(text: string | undefined): number | null {
    const match = /^([+-])(\d{2})(\d{2})$/.exec(text ?? "");
    if (!match) return null;
    const minutes = Number(match[2]) * 60 + Number(match[3]);
    return match[1] === "-" ? -minutes : minutes;
}

/** A local wall-clock time in the container, as the instant it was. */
function instant(
    year: number,
    month: number,
    day: number,
    clock: readonly [number, number, number, number],
    offset: number
): number {
    return Date.UTC(year, month, day, clock[0], clock[1], clock[2], clock[3]) - offset * 60_000;
}

/**
 * The state after one read: the cursor moved to the end of what was read, and
 * the new matching lines added to the kept ones, oldest first and none twice.
 *
 * Null when the script printed nothing usable - no `latest.log`, or a container
 * that answered with something else entirely - which is the caller's cue to read
 * the container's log instead and leave the state as it was.
 */
export function nextPlayerLog(state: PlayerLogState, output: string): PlayerLogState | null {
    const lines = output.split("\n").map((line) => line.replace(/\r$/, ""));
    const clock = /^@clock (\S+) (\d{4}-\d{2}-\d{2})$/.exec(lines[0] ?? "");
    const stat = /^@stat (\d+) (\d+) (\d{4}-\d{2}-\d{2})$/.exec(lines[1] ?? "");
    const from = /^@from (\d+)$/.exec(lines[2] ?? "");
    const offset = offsetMinutes(clock?.[1]);
    if (!clock || !stat || !from || offset === null) return null;

    const found = stamped(lines.slice(3), stat[3]!, offset);
    const kept = new Set(state.lines);
    const merged = [...state.lines, ...found.filter((line) => !kept.has(line))];
    return {
        cursor: { inode: stat[1]!, offset: Number(stat[2]) },
        lines: merged.slice(-KEPT_LINES)
    };
}

/**
 * One read's lines with an instant each.
 *
 * A time of day alone belongs to the day the file was last written, counting back
 * a day each time the clock goes backwards between two lines read from the end:
 * a file is written in order, so a later line with an earlier time crossed a
 * midnight. A line cut in half - by the size cap, or by the read starting inside
 * it - starts with no stamp and is dropped.
 */
function stamped(lines: readonly string[], lastDate: string, offset: number): string[] {
    const [year, month, day] = lastDate.split("-").map(Number) as [number, number, number];
    const kept: { at: number; text: string }[] = [];
    let dayShift = 0;
    let later: number | null = null;
    for (let index = lines.length - 1; index >= 0; index--) {
        const text = lines[index]!;
        const dated = DATED.exec(text);
        if (dated) {
            const monthIndex = MONTHS.indexOf(dated[2]!);
            if (monthIndex < 0) continue;
            const at = instant(
                Number(dated[3]),
                monthIndex,
                Number(dated[1]),
                [Number(dated[4]), Number(dated[5]), Number(dated[6]), Number((dated[7] ?? "0").padEnd(3, "0"))],
                offset
            );
            kept.push({ at, text });
            continue;
        }
        const timed = TIMED.exec(text);
        if (!timed) continue;
        const ofDay =
            ((Number(timed[1]) * 60 + Number(timed[2])) * 60 + Number(timed[3])) * 1000 +
            Number((timed[4] ?? "0").padEnd(3, "0"));
        if (later !== null && ofDay > later) dayShift++;
        later = ofDay;
        const at = instant(year, month - 1, day, [0, 0, 0, 0], offset) + ofDay - dayShift * DAY_MS;
        kept.push({ at, text });
    }
    return kept.reverse().map((line) => `${new Date(line.at).toISOString()} ${line.text}`);
}
