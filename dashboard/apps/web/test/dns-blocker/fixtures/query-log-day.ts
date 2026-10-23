/**
 * A day of the engine's query log, generated: the shape and the size of a busy
 * home network's file (about 90k lines and 15 MB a day), the same every run.
 */

const DAY_MS = 86_400_000;

/** A small seeded generator, so a failing comparison can be read again. */
function random(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
        state = (state * 1_664_525 + 1_013_904_223) >>> 0;
        return state / 2 ** 32;
    };
}

const TYPES = ["A", "AAAA", "A", "AAAA", "HTTPS", "A", "PTR", "SRV"];
const UPSTREAMS = ["tcp-tls:one.one.one.one", "tcp-tls:dns.google", "https://dns.quad9.net"];
const LISTS = ["ads", "tracking", "malware", "social"];

function time(at: number): string {
    return new Date(at).toISOString().slice(0, 19).replace("T", " ");
}

/** One line in the engine's format, at `at` (ms since the epoch). */
export function fixtureLine(at: number, pick: () => number): string {
    const roll = pick();
    const host = Math.floor(pick() ** 2 * 3000);
    const domain = `host-${host}.cdn.example-${host % 97}.test.`;
    const client = `192.168.1.${100 + Math.floor(pick() * 40)}`;
    const names = pick() < 0.7 ? `device-${client.slice(10)}.lan` : client;
    const type = TYPES[Math.floor(pick() * TYPES.length)] ?? "A";
    const upstream = UPSTREAMS[Math.floor(pick() * UPSTREAMS.length)] ?? "";
    const list = LISTS[Math.floor(pick() * LISTS.length)] ?? "";
    const [reason, answer, response] =
        roll < 0.15
            ? [`BLOCKED (${list})`, `${type} (0.0.0.0)`, "BLOCKED"]
            : roll < 0.6
              ? ["CACHED", `${type} (2001:4860:4826:7800::)`, "CACHED"]
              : roll < 0.62
                ? ["CUSTOM DNS", `${type} (192.168.1.2)`, "CUSTOMDNS"]
                : [`RESOLVED (${upstream})`, `${type} (2001:4860:4826:7800::)`, "RESOLVED"];
    return [
        time(at),
        client,
        names,
        String(Math.floor(pick() * 80)),
        reason,
        domain,
        answer,
        "NOERROR",
        response,
        type,
        "f86736065cf0"
    ].join("\t");
}

/** `lines` lookups spread over the UTC day starting at `dayStart`, oldest first. */
export function fixtureDay(dayStart: number, lines: number, seed = 1): string[] {
    const pick = random(seed);
    const out: string[] = [];
    for (let index = 0; index < lines; index += 1)
        out.push(fixtureLine(dayStart + Math.floor((index / lines) * DAY_MS), pick));
    return out;
}
