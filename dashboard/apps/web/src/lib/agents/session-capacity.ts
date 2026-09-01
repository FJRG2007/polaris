/**
 * How many agent sessions may be alive at once, here and per account.
 *
 * Nothing bounded this. Every "Start a session" provisioned a container straight
 * away, so the ceiling was whatever the box would take before it stopped taking
 * any - and the way that shows up is not a refusal, it is every deployed app on
 * the machine getting slower, then a pull failing on a disk that filled with
 * layers nobody asked for. A limit that refuses is enormously better than a
 * limit that arrives as a bad afternoon.
 *
 * Two ceilings rather than one, because they answer different questions. The
 * per-account one stops one person opening forty; the deployment-wide one stops
 * forty people opening one each. Either alone leaves the other case open.
 *
 * **Concurrency, not a rate.** `agent-usage-limits` next door bounds how much
 * work is done over a rolling window, which is about money; this bounds how many
 * machines exist right now, which is about the box. A session that ran all
 * morning and finished costs nothing here.
 *
 * Both are settings with working defaults in code rather than environment
 * variables, because an installed Polaris only reconciles `.env` on the full
 * edition and a limit that only exists once a variable appears is a limit that
 * is switched off on every deployment in the world.
 */

import { prisma } from "@polaris/db";
import { getSetting } from "@/lib/setting-store";

/** What an administrator may change these to. */
export const PER_ACCOUNT_KEY = "agents.sessions.perAccount";
export const INSTANCE_KEY = "agents.sessions.total";

/**
 * Whether this deployment offers a machine everybody shares.
 *
 * Off unless an administrator turns it on, and off is the honest default: a
 * shared machine has one home, so a subscription signed in there is signed in
 * for everybody who can open it, and the files one person leaves are the files
 * the next person finds. That is exactly what a team with one subscription
 * wants and exactly what a deployment of separate people does not, and nobody
 * but an administrator knows which of those this is.
 */
export const SHARED_WORKSPACE_KEY = "agents.sessions.sharedWorkspace";

/** Whether it is on. Anything but a stored "true" is off - a setting nobody can
 *  read must not open a shared machine by accident. */
export async function sharedWorkspaceAllowed(): Promise<boolean> {
    const stored = await getSetting(SHARED_WORKSPACE_KEY).catch(() => null);
    return stored === "true";
}

/**
 * The defaults.
 *
 * Chosen for the machine most Polaris deployments actually are - one box that is
 * also serving everything else on it - rather than for a build server. A session
 * is a container holding a checkout, a package install and a language model's
 * worth of a tool, so three at once per person is already a busy afternoon and
 * twelve across a deployment is a machine with nothing spare.
 *
 * Both are raised by an administrator rather than by editing anything, and a
 * deployment with room to spare should raise them.
 */
export const DEFAULT_PER_ACCOUNT = 3;
export const DEFAULT_TOTAL = 12;

/** Read one, falling back to its default. A stored value that is not a positive
 *  whole number is treated as unset: a limit nobody can read is a limit that
 *  must not silently become zero and refuse everything. */
async function ceiling(key: string, fallback: number): Promise<number> {
    const stored = await getSetting(key).catch(() => null);
    const value = Number(stored);
    return Number.isInteger(value) && value > 0 ? value : fallback;
}

/** The states that still hold a machine. Anything else has been torn down, so it
 *  costs nothing and is not counted. */
const ALIVE = ["starting", "working", "waiting", "idle"];

export interface Capacity {
    readonly mine: number;
    readonly perAccount: number;
    readonly total: number;
    readonly totalCeiling: number;
}

/** What is running, and what the ceilings are. One call, so a screen and the
 *  guard cannot disagree about what is left. */
export async function sessionCapacity(userId: string): Promise<Capacity> {
    const [mine, total, perAccount, totalCeiling] = await Promise.all([
        prisma.agentSession.count({ where: { startedById: userId, state: { in: ALIVE } } }),
        prisma.agentSession.count({ where: { state: { in: ALIVE } } }),
        ceiling(PER_ACCOUNT_KEY, DEFAULT_PER_ACCOUNT),
        ceiling(INSTANCE_KEY, DEFAULT_TOTAL)
    ]);
    return { mine, perAccount, total, totalCeiling };
}

/**
 * Why a session may not start right now, or null.
 *
 * A sentence rather than a code, and it says which ceiling and what would free
 * it - the two things somebody looking at a refusal actually needs. The
 * deployment-wide one deliberately does not say who is holding the other
 * sessions: it is a number, not a list of what other people are working on.
 *
 * Nothing is queued. A session is a conversation somebody is about to have, and
 * starting one twenty minutes later against a prompt written for a repository
 * that has moved on is worse than being told now - so this refuses, and the
 * person decides whether to stop one of their own.
 */
export function capacityRefusal(capacity: Capacity): string | null {
    if (capacity.mine >= capacity.perAccount) {
        return `You already have ${capacity.mine} sessions running, which is the most one account may have at once. Stop one and this will start.`;
    }
    if (capacity.total >= capacity.totalCeiling) {
        return "This Polaris is running as many agent sessions as it is set to allow. Try again when one finishes, or ask an administrator to raise the limit.";
    }
    return null;
}
