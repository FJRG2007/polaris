/**
 * The lines about players arriving and leaving, read in a way nothing can drown.
 *
 * The container's log is everything the server printed, and a server Polaris talks
 * to prints two lines for every command it is sent - "Thread RCON Client started",
 * "shutting down" - because each command is its own RCON connection. On a server
 * somebody is watching that is every few seconds, and the last 1500 lines of one
 * such server were found to be exactly that and nothing else: no join, no leave,
 * no login address. Anything that read players from that tail read nobody.
 *
 * So the lines that matter are picked out inside the container, from the server's
 * own `logs/latest.log` and the newest rotated file beside it, before anything is
 * cut to size: the chatter never reaches the cap. The output of one command is cut
 * at 16 KiB with no marker (see `container-files`), so each part is capped at the
 * end that matters - the newest lines - well under it.
 *
 * The file's stamps are the server's local time, and on vanilla and Paper only the
 * time of day. The container's own date and offset are printed beside them, so each
 * line is turned into the same RFC3339 instant the container's log carries, and
 * every reader that already parses that shape reads this unchanged.
 *
 * Pure apart from the script's text: the command runs in `service.ts`.
 */

/** The lines worth keeping: arrivals, departures, and the server starting or
 *  stopping, for Java and for Bedrock's own wording. A fixed pattern - nothing a
 *  player or an operator typed is ever part of this command. */
const WANTED =
    "logged in with entity id|joined the game|left the game|lost connection: |Starting minecraft server version|Stopping server|Player connected:|Player disconnected:";

/** How much of each file to keep, newest last. Together, and with the headers,
 *  under the 16 KiB one command can return. */
const LATEST_BYTES = 11_000;
const ROTATED_BYTES = 4_000;

const LOGS = "/data/logs";

/**
 * The command, run with `sh -c` in the server's container.
 *
 * Prints `@clock <offset> <date>` first, then each file as `@file <name> <date of
 * its last write>` followed by its matching lines. Prints nothing about a file
 * that is not there, so a server with no `latest.log` - Bedrock writes none - reads
 * as having none, and the caller falls back to the container's log.
 */
export const PLAYER_LOG_SCRIPT = [
    `P='${WANTED}'`,
    `echo "@clock $(date +%z) $(date +%F)"`,
    `g=$(ls -1t ${LOGS}/*.log.gz 2>/dev/null | head -n 1)`,
    `if [ -n "$g" ]; then echo "@file $(basename "$g") $(date -r "$g" +%F)"; gzip -dc "$g" 2>/dev/null | grep -aE "$P" | tail -c ${ROTATED_BYTES}; echo; fi`,
    `if [ -f ${LOGS}/latest.log ]; then echo "@file latest.log $(date -r ${LOGS}/latest.log +%F)"; grep -aE "$P" ${LOGS}/latest.log | tail -c ${LATEST_BYTES}; fi`
].join("\n");

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
 * The script's output as container-log lines - `<RFC3339> <line>` - oldest first.
 *
 * Null when it printed nothing usable, which is the caller's cue to read the
 * container's log instead.
 */
export function playerLogLines(output: string): string | null {
    const lines = output.split("\n").map((line) => line.replace(/\r$/, ""));
    const clock = /^@clock (\S+) (\d{4}-\d{2}-\d{2})$/.exec(lines[0] ?? "");
    const offset = offsetMinutes(clock?.[1]);
    if (!clock || offset === null) return null;

    const sections: { date: string; lines: string[] }[] = [];
    for (const line of lines.slice(1)) {
        const header = /^@file (\S+) (\d{4}-\d{2}-\d{2})$/.exec(line);
        if (header) {
            // A rotated file is named for the day it covers; its last write can be
            // the rotation itself, just after midnight on the next one.
            const named = /^(\d{4}-\d{2}-\d{2})-\d+\.log\.gz$/.exec(header[1]!)?.[1];
            sections.push({ date: named ?? header[2]!, lines: [] });
        } else sections.at(-1)?.lines.push(line);
    }
    if (sections.length === 0) return null;
    return sections.flatMap((section) => stamped(section.lines, section.date, offset)).join("\n");
}

/**
 * One file's lines with an instant each.
 *
 * A time of day alone belongs to the day the file was last written, counting back
 * a day each time the clock goes backwards between two lines read from the end:
 * a file is written in order, so a later line with an earlier time crossed a
 * midnight. A line cut in half by the size cap starts with no stamp and is dropped.
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
