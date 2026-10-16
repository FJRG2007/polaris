/**
 * Whether another dashboard is still running beside this one.
 *
 * An update starts the new dashboard while the previous one keeps serving, and only
 * retires the old one once the new one is healthy (`roll_over` in scripts/update.sh).
 * For those seconds - longer, while the old one finishes what it had started - two
 * processes are alive, and each holds its own in-memory deploy queue. A boot task
 * that closes out "deploys this process cannot be running" must therefore wait until
 * it is the only one: until then, a row reading `deploying` may be the other
 * process's work, live and about to finish.
 *
 * Asked of the engine through the daemon, by the compose labels this container
 * carries. No daemon (the limited edition, which is never rolled over) or no answer
 * reads as "alone", which is what this process assumed before it asked.
 *
 * Server-only.
 */

import { hostname } from "node:os";
import { HostdClient } from "@polaris/hostd-client";

/** How often to look again while the previous dashboard is still up. */
const RECHECK_MS = 15_000;

/** When to stop waiting. Far longer than any rollover; a second dashboard still
 *  running after this is not one an update left behind. */
const GIVE_UP_MS = 30 * 60_000;

interface ContainerSummary {
    Id?: string;
}

/** True when a running container other than `ownId` is in `listed`. */
export function othersAmong(ownId: string, listed: readonly ContainerSummary[]): boolean {
    return listed.some((entry) => typeof entry.Id === "string" && entry.Id !== ownId);
}

/** Whether another container of this compose service is running, or null when that
 *  cannot be told. */
export async function otherDashboardRunning(): Promise<boolean | null> {
    try {
        const client = new HostdClient();
        const own = await client.dockerRequest("GET", `/containers/${hostname()}/json`);
        if (own.status !== 200) return null;
        const self = JSON.parse(own.body) as {
            Id?: string;
            Config?: { Labels?: Record<string, string> };
        };
        const project = self.Config?.Labels?.["com.docker.compose.project"];
        const service = self.Config?.Labels?.["com.docker.compose.service"];
        if (!self.Id || !project || !service) return null;
        const filters = encodeURIComponent(
            JSON.stringify({
                label: [`com.docker.compose.project=${project}`, `com.docker.compose.service=${service}`],
                status: ["running"]
            })
        );
        const listed = await client.dockerRequest("GET", `/containers/json?filters=${filters}`);
        if (listed.status !== 200) return null;
        const rows = JSON.parse(listed.body) as unknown;
        return Array.isArray(rows) ? othersAmong(self.Id, rows as ContainerSummary[]) : null;
    } catch {
        return null;
    }
}

/**
 * Run `work` once no other dashboard is running, checking every `recheckMs`. After
 * `giveUpMs` it runs anyway, and says so.
 */
export async function whenAlone(
    work: () => Promise<void>,
    options: {
        peers?: () => Promise<boolean | null>;
        recheckMs?: number;
        giveUpMs?: number;
        sleep?: (ms: number) => Promise<void>;
    } = {}
): Promise<void> {
    const peers = options.peers ?? otherDashboardRunning;
    const recheckMs = options.recheckMs ?? RECHECK_MS;
    const giveUpMs = options.giveUpMs ?? GIVE_UP_MS;
    const sleep =
        options.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms).unref()));
    for (let waited = 0; waited < giveUpMs; waited += recheckMs) {
        if ((await peers()) !== true) return work();
        await sleep(recheckMs);
    }
    console.warn("polaris: another dashboard has been running beside this one for 30 minutes; going ahead");
    return work();
}

/** One wait for the whole process, kept on the process rather than in this module:
 *  Next can evaluate a module once per bundle layer, and every copy should share it. */
const shared = globalThis as { [key: symbol]: Promise<void> | undefined };
const PREDECESSOR = Symbol.for("polaris.dashboard-peers.predecessor");

/**
 * Resolves once the dashboard this one replaced has been retired - at once when
 * there never was one. Shared by every boot task that must not run beside it:
 * whatever the previous dashboard is still doing during the rollover (a deploy, a
 * copy, a tunnel, a timer of its own) is its to finish, and the same loop started
 * here as well would do it twice. Never rejects.
 */
export function afterPredecessor(): Promise<void> {
    shared[PREDECESSOR] ??= whenAlone(async () => undefined).catch(() => undefined);
    return shared[PREDECESSOR];
}
