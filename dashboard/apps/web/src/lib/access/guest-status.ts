/**
 * A NAS, a server or a domain handed out as a link: seen, never driven.
 *
 * The link is a grant like any other (principal `link`, see
 * `lib/access/grants.ts`), and for these three it can only ever be a `view`
 * one (`core.linkCapabilities`). What a guest is shown is what a visitor
 * needs to know whether the thing is working - its name, up or down, and how
 * long it has been up where that is known - and never where it is reached: no
 * host, address, port, path, environment or log leaves this file.
 *
 * Reading is not a use: a status page refreshed is not something done to the
 * machine. Each subject is asked at most once per `READ_TTL_MS` however many
 * links and tabs look at it.
 *
 * Server-only.
 */

import { prisma } from "@polaris/db";
import { linkReach } from "@/lib/access/grants";
import { readNas, nasRow } from "@/lib/nas/nas-service";
import { getWatchServers } from "@/lib/watch-overview-service";
import { domainOwner, lendableServer } from "@/lib/machines/machine-access";

/** How long one reading answers every link to the same thing. */
const READ_TTL_MS = 15_000;

export type GuestStatusKind = "nas" | "server" | "domain";

/** What the guest page draws. */
export interface GuestStatusView {
    readonly kind: GuestStatusKind;
    readonly name: string;
    readonly state: "up" | "down" | "unknown";
    /** Seconds it has been up, where the thing itself says. */
    readonly uptimeSeconds: number | null;
    /** When the state was last checked, where that is recorded. */
    readonly checkedAt: string | null;
    readonly until: string | null;
    readonly note: string;
}

type Reading = Pick<GuestStatusView, "name" | "state" | "uptimeSeconds" | "checkedAt">;

const KINDS: Record<string, GuestStatusKind> = {
    "place.nas": "nas",
    "place.server": "server",
    "place.domain": "domain"
};

const readings = new Map<string, { at: number; result: Promise<Reading | null> }>();

function shared(key: string, read: () => Promise<Reading | null>): Promise<Reading | null> {
    const now = Date.now();
    const kept = readings.get(key);
    if (kept && now - kept.at < READ_TTL_MS) return kept.result;
    for (const [id, one] of readings) if (now - one.at >= READ_TTL_MS) readings.delete(id);
    const result = read().catch(() => null);
    readings.set(key, { at: now, result });
    return result;
}

async function readServer(id: string): Promise<Reading | null> {
    // Never the machine Polaris runs on, whatever a row says.
    const host = await lendableServer(id);
    if (!host) return null;
    const card = (await getWatchServers(host.ownerId)).find((one) => one.id === host.id);
    return {
        name: host.name,
        state: card?.state === "up" ? "up" : card?.state === "down" ? "down" : "unknown",
        uptimeSeconds: null,
        checkedAt: null
    };
}

async function readDomain(id: string): Promise<Reading | null> {
    if (!(await domainOwner(id))) return null;
    const row = await prisma.domain.findUnique({
        where: { id },
        select: { hostname: true, healthStatus: true, healthCheckedAt: true }
    });
    if (!row) return null;
    return {
        name: row.hostname,
        state: row.healthStatus === "up" ? "up" : row.healthStatus === "down" ? "down" : "unknown",
        uptimeSeconds: null,
        checkedAt: row.healthCheckedAt?.toISOString() ?? null
    };
}

async function readNasStatus(id: string): Promise<Reading | null> {
    const row = await nasRow(id);
    if (!row?.ownerId) return null;
    const answer = await readNas(row.id, row.ownerId, "1h", true);
    return {
        name: row.name,
        state: answer.status.ok ? "up" : "down",
        uptimeSeconds: answer.status.ok ? answer.status.value.uptimeSeconds : null,
        checkedAt: new Date().toISOString()
    };
}

/** What a watch-only link shows now, or null when it opens nothing. */
export async function guestStatusView(token: string): Promise<GuestStatusView | null> {
    const link = await linkReach(token);
    if (!link || link.standing !== "live") return null;
    const kind = KINDS[link.subjectType];
    if (!kind) return null;
    const read = kind === "server" ? readServer : kind === "domain" ? readDomain : readNasStatus;
    const reading = await shared(`${kind}:${link.subjectId}`, () => read(link.subjectId));
    if (!reading) return null;
    return {
        kind,
        ...reading,
        until: link.grant.until?.toISOString() ?? null,
        note: link.note
    };
}

/** For tests: forget the shared readings. */
export function forgetGuestReadings(): void {
    readings.clear();
}
