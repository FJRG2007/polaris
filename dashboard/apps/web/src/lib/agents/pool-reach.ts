/**
 * Whether each server in Polar Code's pool reaches this Polaris.
 *
 * A session reports everything it does - its events, its permission prompts,
 * its git credential - by calling Polaris's own address from where it runs. A
 * pool server that cannot reach that address starts sessions that never say a
 * word: they look stuck, and nothing on the screen says why. So each server is
 * asked, over the SSH Polaris already holds for it, to fetch `/api/health` at
 * the address sessions are given, and the answer is kept:
 *
 * - on the administrator's screen, beside the server, with the address it
 *   tried, so what to fix (a firewall, a name only this network resolves, a
 *   certificate the server does not trust) is the one thing in front of them;
 * - by placement, which leaves out a server that could not reach Polaris the
 *   last time it was asked, until a later check finds that it can.
 *
 * Asked again by the cron every `RECHECK_MS`, a few servers per run, and at
 * once from the screen. Kept as one settings row: there is one entry per pool
 * server, and the pool is the administrator's list.
 *
 * Server-only.
 */

import { execCommand } from "@polaris/ssh";
import { shellQuote } from "./session-hooks";
import { appBaseUrl } from "@/lib/domain-service";
import { borrowSsh } from "@/lib/connection-pool";
import { setSetting } from "@/lib/setting-store";
import { getHostConnectionUnscoped } from "@/lib/host-service";
import { REACH_KEY, RECHECK_MS, readReach, type Reach, type ReachState } from "./pool-reach-state";

/** Servers asked per cron run. The rest wait for the next one. */
const PER_RUN = 8;

/**
 * What the server runs: the HTTP status it got, `none` without either tool.
 * A 503 is still Polaris answering (its database is not), so it counts.
 * wget's exit code 8 is "the server answered with an error".
 */
export function reachScript(url: string): string {
    const target = shellQuote(url);
    return [
        "if command -v curl >/dev/null 2>&1; then",
        `  curl -s -o /dev/null -m 8 -w '%{http_code}' ${target}`,
        "elif command -v wget >/dev/null 2>&1; then",
        `  wget -q -T 8 -t 1 -O /dev/null ${target}; c=$?`,
        '  if [ "$c" -eq 0 ]; then echo 200; elif [ "$c" -eq 8 ]; then echo 503; else echo 000; fi',
        "else",
        "  echo none",
        "fi"
    ].join("\n");
}

export function readReachOutput(output: string): Exclude<ReachState, "down"> {
    const said = output.trim();
    if (said === "none") return "noTool";
    return said === "200" || said === "503" ? "ok" : "blocked";
}

/** The address sessions are told to report to, and its health check. */
async function healthUrl(): Promise<{ base: string; url: string }> {
    const base = (await appBaseUrl()).replace(/\/+$/, "");
    return { base, url: `${base}/api/health` };
}

/** Ask one server now. Never throws. */
export async function probeReach(hostId: string, now = Date.now()): Promise<Reach> {
    const { base, url } = await healthUrl();
    try {
        const host = await getHostConnectionUnscoped(hostId);
        const lease = await borrowSsh("exec", hostId, {
            host: host.address,
            port: host.port,
            username: host.username,
            auth: host.auth,
            pinnedHostKey: host.hostKey
        });
        try {
            let said = "";
            await execCommand(lease.client, reachScript(url), {
                onStdout: (chunk) => {
                    said += chunk.toString("utf8");
                }
            });
            return { state: readReachOutput(said), at: now, url: base };
        } finally {
            lease.release();
        }
    } catch {
        return { state: "down", at: now, url: base };
    }
}

/** Keep these answers, for the servers still in the pool only. */
async function store(answers: Record<string, Reach>, pool: readonly string[]): Promise<void> {
    const kept = await readReach();
    const next: Record<string, Reach> = {};
    for (const hostId of pool) {
        const answer = answers[hostId] ?? kept[hostId];
        if (answer) next[hostId] = answer;
    }
    await setSetting(REACH_KEY, JSON.stringify(next));
}

/** Ask one server and keep the answer: the screen's "check now". */
export async function checkReach(hostId: string, pool: readonly string[]): Promise<Reach> {
    const answer = await probeReach(hostId);
    await store({ [hostId]: answer }, pool);
    return answer;
}

/**
 * The cron's part: ask the servers whose answer is oldest, a few per run.
 * Answers how many were asked.
 */
export async function recheckReach(pool: readonly string[], now = Date.now()): Promise<number> {
    if (pool.length === 0) return 0;
    const kept = await readReach();
    const due = pool
        .filter((hostId) => !kept[hostId] || now - kept[hostId]!.at >= RECHECK_MS)
        .sort((a, b) => (kept[a]?.at ?? 0) - (kept[b]?.at ?? 0))
        .slice(0, PER_RUN);
    if (due.length === 0) return 0;
    const answers = await Promise.all(due.map((hostId) => probeReach(hostId, now)));
    await store(Object.fromEntries(due.map((hostId, index) => [hostId, answers[index]!])), pool);
    return due.length;
}
