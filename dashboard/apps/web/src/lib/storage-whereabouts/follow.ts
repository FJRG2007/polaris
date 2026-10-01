/**
 * A storage on the local network follows its device, not its address.
 *
 * The incident this exists for: a UNAS Pro configured at one address took a new
 * DHCP lease, nothing answered at the old one any more, and Polaris kept dialling
 * it - uploads fell back to this server and every profile photo broke - while the
 * box sat on the shelf answering three addresses further along. The operator
 * never uses a terminal, so Polaris has to notice, look, and follow by itself.
 *
 * Three jobs, one rule. The rule is that an address is never trusted: whatever
 * answers there has to be the device that was remembered (see `compareIdentity`)
 * before the stored password is sent to it.
 *
 * - Before credentials go anywhere (`confirmBeforeCredentials`), the device at
 *   the address is asked who it is. A different SMB server that picked up the
 *   old address is refused, not signed in to.
 * - After credentials worked (`rememberAfterSuccess`), what the device said
 *   about itself is kept on the connection.
 * - When it stops answering (`searchFor`), the host's neighbour table is read for
 *   its hardware address, then the /24 is swept on 445, and a device that proves
 *   to be the same one becomes the connection's address.
 *
 * Server-only.
 */

import { prisma, Prisma } from "@polaris/db";
import { isLocalAddress, withTimeout } from "@polaris/core";
import type { StorageConfig } from "@polaris/core";
import { probeSmbIdentity, type SmbProbeResult } from "./smb-probe";
import { readNeighbourTable, type NeighbourTable } from "./neighbours";
import * as who from "./identity";

/** The kinds reached over SMB at an address, which is what this can follow. NFS
 *  has no anonymous way to say who it is, and every other kind is a URL. */
export const FOLLOWED_KINDS = ["smb", "unifi-unas"] as const;

export function isFollowedKind(kind: string): boolean {
    return (FOLLOWED_KINDS as readonly string[]).includes(kind);
}

/** What this module needs of a connection row. */
export interface FollowedRow {
    readonly id: string;
    readonly name: string;
    readonly kind: string;
    readonly config: string;
    readonly deviceIdentity?: unknown;
}

/** The network it reaches out on, so tests can stand in for it. */
export interface Network {
    probe(address: string, fast: boolean): Promise<SmbProbeResult>;
    neighbours(): Promise<NeighbourTable>;
}

const realNetwork: Network = {
    probe: (address, fast) =>
        probeSmbIdentity(
            address,
            fast
                ? { connectTimeoutMs: 700, timeoutMs: 3_000 }
                : { connectTimeoutMs: 2_500, timeoutMs: 6_000 }
        ),
    neighbours: () => readNeighbourTable()
};

let network: Network = realNetwork;

/** For tests: put a fake network in place, or the real one back with no argument. */
export function useNetwork(next?: Network): void {
    network = next ?? realNetwork;
    verified.clear();
    searches.clear();
    lastRemembered.clear();
}

/** The address a followed connection dials, or null for one with none. */
export function addressOf(row: Pick<FollowedRow, "config">): string | null {
    try {
        const config = JSON.parse(row.config) as { host?: unknown };
        return typeof config.host === "string" && config.host.trim() ? config.host.trim() : null;
    } catch {
        return null;
    }
}

/** Whether a row is one this can follow: an SMB kind at a private IPv4 address.
 *  A hostname is the network's own way of following a device, and is left to it. */
export function isFollowable(row: Pick<FollowedRow, "kind" | "config">): boolean {
    const address = addressOf(row);
    return isFollowedKind(row.kind) && address !== null && isLocalAddress(address);
}

/** Who answers at an address: its SMB identity, with its hardware address from
 *  the host's table when one is given or asked for. */
async function observe(
    address: string,
    options: { fast?: boolean; table?: NeighbourTable; withMac?: boolean } = {}
): Promise<
    | { answered: false; reason: "closed" | "refused" }
    | { answered: true; identity: who.DeviceIdentity }
> {
    const probe = await network.probe(address, options.fast ?? false);
    if (!probe.ok) return { answered: false, reason: probe.reason };
    const table = options.table ?? (options.withMac ? await network.neighbours() : undefined);
    const mac = table?.get(address);
    return {
        answered: true,
        identity: who.normalizeIdentity({ ...probe.identity, ...(mac ? { mac } : {}) })
    };
}

/** Compare, and when the SMB answer alone cannot decide, add the hardware
 *  address and compare again. The neighbour table costs an exec on the host, so
 *  it is only read when it can change the answer. */
async function judge(
    remembered: who.DeviceIdentity,
    address: string,
    identity: who.DeviceIdentity,
    table?: NeighbourTable
): Promise<{ verdict: who.Verdict; identity: who.DeviceIdentity }> {
    const first = who.compareIdentity(remembered, identity);
    if (first === "same" || identity.mac || !who.normalizeIdentity(remembered).mac) {
        return { verdict: first, identity };
    }
    const mac = (table ?? (await network.neighbours())).get(address);
    if (!mac) return { verdict: first, identity };
    const withMac = who.normalizeIdentity({ ...identity, mac });
    return { verdict: who.compareIdentity(remembered, withMac), identity: withMac };
}

// --- before credentials ------------------------------------------------------

/** A connection whose device could not be confirmed at its address. The
 *  message reads as a storage that is not there, which is what it is to every
 *  caller: an upload falls back, a read fails, and nothing is signed in to. */
export class DeviceNotConfirmed extends Error {
    constructor(message: string) {
        super(message);
        this.name = "DeviceNotConfirmed";
    }
}

/** How long a device confirmed at an address is taken on trust. The same window
 *  a live mount is trusted for: a burst of browsing costs one probe, and a
 *  device that went away is noticed within the minute. */
const VERIFIED_FOR_MS = 60_000;

/** `${connectionId}|${address}` -> when it was last confirmed. In this process
 *  only: it is a latency shortcut. */
const verified = new Map<string, number>();

/**
 * Refuse to hand this connection's credentials to anything but the device it
 * remembers.
 *
 * Nothing to check for a connection that has not remembered one yet (a new
 * connection, or one made before this existed): it is learned the first time
 * the credentials work. Once there is one, the device has to say who it is
 * before every sign-in, and a device that will not - or that says it is somebody
 * else - does not get the password.
 */
export async function confirmBeforeCredentials(row: FollowedRow): Promise<void> {
    if (!isFollowable(row)) return;
    const remembered = who.readRemembered(row.deviceIdentity);
    if (!remembered || !who.canConfirm(remembered)) return;
    const address = addressOf(row)!;
    const key = `${row.id}|${address}`;
    const at = verified.get(key);
    if (at !== undefined && Date.now() - at < VERIFIED_FOR_MS) return;

    const seen = await observe(address);
    if (!seen.answered) {
        void searchFor(row.id).catch(() => undefined);
        throw new DeviceNotConfirmed(`${row.name} did not answer at ${address}`);
    }
    const { verdict, identity } = await judge(remembered, address, seen.identity);
    if (verdict !== "same") {
        // The one this exists for: something is at the address, and it is not the
        // device the password belongs to. Look for the real one.
        void searchFor(row.id).catch(() => undefined);
        const label = who.deviceLabel(identity);
        console.error(
            `storage: ${row.name} - the device at ${address} is not the one this connection remembers (${label ?? "unnamed"}); not signing in`
        );
        throw new DeviceNotConfirmed(
            `${row.name} did not answer at ${address}: a different device is there now`
        );
    }
    verified.set(key, Date.now());
}

// --- after credentials -------------------------------------------------------

/** How often an identity already remembered is refreshed. It changes rarely and
 *  the refresh is a write. */
const REMEMBER_EVERY_MS = 6 * 60 * 60 * 1000;

const lastRemembered = new Map<string, number>();

/**
 * Keep who answered, now that the credentials have proved it is the right device.
 *
 * Background and best-effort: called after a connection opened, never awaited by
 * it. Also how a connection made before this existed starts being followed.
 */
export async function rememberAfterSuccess(row: FollowedRow): Promise<void> {
    if (!isFollowable(row)) return;
    const address = addressOf(row)!;
    const remembered = who.readRemembered(row.deviceIdentity);
    const fresh =
        remembered &&
        who.canConfirm(remembered) &&
        remembered.address === address &&
        Date.now() - Date.parse(remembered.seenAt) < REMEMBER_EVERY_MS;
    if (fresh) return;
    const last = lastRemembered.get(row.id);
    if (last !== undefined && Date.now() - last < 60_000) return;
    lastRemembered.set(row.id, Date.now());

    const seen = await observe(address, { withMac: true });
    if (!seen.answered || !who.canConfirm(seen.identity)) return;
    // A remembered device that is positively someone else is not overwritten
    // here: the check before sign-in is what decides that, and it refused.
    if (
        remembered &&
        who.canConfirm(remembered) &&
        who.compareIdentity(remembered, seen.identity) === "different"
    ) {
        return;
    }
    await saveIdentity(row, who.mergeIdentity(remembered, seen.identity, address, new Date()));
}

/** Written only while the connection still dials the address it was seen at:
 *  an identity learned at an address somebody has since changed belongs to
 *  nobody. */
async function saveIdentity(row: FollowedRow, identity: who.RememberedIdentity): Promise<void> {
    await prisma.storageConnection.updateMany({
        where: { id: row.id, config: row.config },
        data: { deviceIdentity: { ...identity } }
    });
}
// --- looking for it -----------------------------------------------------------

/** What a search found. */
export type SearchOutcome =
    /** It is where it is meant to be, answering as itself. */
    | { readonly kind: "answering"; readonly address: string }
    /** It was found elsewhere, proved to be itself, and is now dialled there. */
    | {
          readonly kind: "followed";
          readonly from: string;
          readonly to: string;
          readonly mac: string | null;
      }
    /** Nothing was remembered to prove a device by, and these SMB servers answer
     *  on the network. Somebody has to say which, if any, it is. */
    | { readonly kind: "candidates"; readonly candidates: readonly Candidate[] }
    /** Something answers at its address that cannot be proved to be it, and it
     *  was not found anywhere else. Its password is not sent there. */
    | { readonly kind: "impostor"; readonly address: string; readonly label: string | null }
    /** Not at its address and not anywhere on the network. */
    | { readonly kind: "gone"; readonly address: string }
    /** Not a storage this can look for (not SMB, not at a private address, or
     *  changed while it was being looked for). */
    | { readonly kind: "unsupported" };

export interface Candidate {
    readonly address: string;
    readonly label: string | null;
    readonly mac: string | null;
}

export interface SearchRecord {
    readonly outcome: SearchOutcome;
    /** ISO time. */
    readonly at: string;
}

/** How long one search's answer stands for the searches nobody asked for. A NAS
 *  that is off for an afternoon costs one sweep every ten minutes, not one per
 *  failed avatar. */
const SEARCH_EVERY_MS = 10 * 60 * 1000;

/** The least time between two searches somebody asked for by pressing a button. */
const SEARCH_FLOOR_MS = 15_000;

/** How many addresses are asked at once. Enough to sweep a /24 in a few
 *  seconds; few enough that a home router's connection table does not notice. */
const SWEEP_CONCURRENCY = 24;

/** The whole search, sweep included, is given up past this. */
const SEARCH_DEADLINE_MS = 60_000;

const searches = new Map<
    string,
    { startedAt: number; running: Promise<SearchOutcome> | null; record: SearchRecord | null }
>();

/** The last thing a search for this connection found, if one has run here. */
export function lastSearch(connectionId: string): SearchRecord | null {
    return searches.get(connectionId)?.record ?? null;
}

/**
 * Look for a storage's device on its network, and follow it if it moved.
 *
 * Shared: two callers asking at once get one search, and a search finished
 * recently is answered from memory unless `force` (a person pressed "Find it
 * again") - which still waits out a short floor, so a held key cannot sweep the
 * network in a loop.
 */
export function searchFor(
    connectionId: string,
    options: { force?: boolean } = {}
): Promise<SearchOutcome> {
    const entry = searches.get(connectionId);
    if (entry?.running) return entry.running;
    if (entry?.record) {
        const age = Date.now() - entry.startedAt;
        if (age < (options.force ? SEARCH_FLOOR_MS : SEARCH_EVERY_MS)) {
            return Promise.resolve(entry.record.outcome);
        }
    }
    const startedAt = Date.now();
    const stop = new AbortController();
    const running = withTimeout(
        search(connectionId, stop.signal),
        SEARCH_DEADLINE_MS,
        "the search took too long"
    )
        .catch((error: unknown): SearchOutcome => {
            console.error(`storage: looking for ${connectionId} on the network failed:`, error);
            return { kind: "unsupported" };
        })
        .then((outcome) => {
            stop.abort();
            searches.set(connectionId, {
                startedAt,
                running: null,
                record: { outcome, at: new Date().toISOString() }
            });
            return outcome;
        });
    searches.set(connectionId, { startedAt, running, record: entry?.record ?? null });
    return running;
}

async function search(connectionId: string, signal: AbortSignal): Promise<SearchOutcome> {
    const row = await prisma.storageConnection.findUnique({
        where: { id: connectionId },
        select: { id: true, name: true, kind: true, config: true, deviceIdentity: true }
    });
    if (!row || !isFollowable(row)) return { kind: "unsupported" };
    const address = addressOf(row)!;
    const remembered = who.readRemembered(row.deviceIdentity);
    const provable = remembered !== null && who.canConfirm(remembered);

    // Where it is meant to be, first. Most "it stopped answering" is a blip.
    const here = await observe(address);
    let stranger: who.DeviceIdentity | null = null;
    if (here.answered) {
        if (!provable) return { kind: "answering", address };
        const { verdict, identity } = await judge(remembered, address, here.identity);
        if (verdict === "same") return { kind: "answering", address };
        // Somebody else has its address. Keep looking for the real one.
        stranger = identity;
    }

    const neighbourhood = new Set(who.neighbourhoodOf(address));

    // The host's table, by hardware address: free, and right whenever the host
    // has spoken to the device since it moved.
    let table = await network.neighbours();
    if (provable && remembered.mac) {
        for (const [ip, mac] of table) {
            if (signal.aborted) return { kind: "unsupported" };
            if (mac !== remembered.mac || ip === address || !neighbourhood.has(ip)) continue;
            const seen = await observe(ip, { table });
            if (!seen.answered) continue;
            const { verdict, identity } = await judge(remembered, ip, seen.identity, table);
            if (verdict === "same") return follow(row, remembered, ip, identity, signal);
        }
    }

    // Then the sweep: every address on the /24, nearest first, asked on 445.
    const answered: { address: string; identity: who.DeviceIdentity }[] = [];
    let found = false;
    const queue = [...neighbourhood];
    const worker = async () => {
        while (queue.length > 0 && !found && !signal.aborted) {
            const ip = queue.shift()!;
            const seen = await observe(ip, { fast: true });
            if (!seen.answered) continue;
            const hit = provable && who.compareIdentity(remembered, seen.identity) === "same";
            // A device that proves itself by GUID goes to the front, and stops
            // the sweep: everything after it would be asked for nothing.
            if (hit) answered.unshift({ address: ip, identity: seen.identity });
            else answered.push({ address: ip, identity: seen.identity });
            if (hit) found = true;
        }
    };
    await Promise.all(Array.from({ length: SWEEP_CONCURRENCY }, worker));
    if (signal.aborted) return { kind: "unsupported" };

    // The sweep itself fills the host's table with everyone it reached, so it
    // is read again: a device whose GUID changed is still recognised by its
    // hardware address.
    table = await network.neighbours();
    if (provable) {
        for (const candidate of answered) {
            const { verdict, identity } = await judge(
                remembered,
                candidate.address,
                candidate.identity,
                table
            );
            if (verdict === "same")
                return follow(row, remembered, candidate.address, identity, signal);
        }
        return stranger
            ? { kind: "impostor", address, label: who.deviceLabel(stranger) }
            : { kind: "gone", address };
    }

    // Nothing to prove a device by: say who answers, and let a person choose.
    const candidates = answered
        .sort((a, b) => lastOctet(a.address) - lastOctet(b.address))
        .map((candidate) => ({
            address: candidate.address,
            label: who.deviceLabel(candidate.identity),
            mac: table.get(candidate.address) ?? null
        }));
    return candidates.length > 0 ? { kind: "candidates", candidates } : { kind: "gone", address };
}

function lastOctet(address: string): number {
    return Number(address.split(".")[3] ?? 0);
}

/**
 * Point a connection at the address its device was found at, and tell the
 * administrators.
 */
async function follow(
    row: FollowedRow,
    remembered: who.RememberedIdentity,
    to: string,
    identity: who.DeviceIdentity,
    signal: AbortSignal
): Promise<SearchOutcome> {
    if (signal.aborted) return { kind: "unsupported" };
    const from = addressOf(row)!;
    const merged = who.mergeIdentity(remembered, identity, to, new Date());
    if (!(await repoint(row, to, merged))) {
        // Somebody changed the connection while this was looking. Theirs stands.
        return { kind: "unsupported" };
    }
    console.warn(`storage: ${row.name} moved from ${from} to ${to}; following it`);
    const mac = merged.mac ?? null;
    void import("@/lib/storage-alert")
        .then((alert) => alert.reportStorageMoved({ id: row.id, name: row.name, from, to, mac }))
        .catch(() => undefined);
    return { kind: "followed", from, to, mac };
}

/**
 * Change a connection's address and identity together, and drop everything this
 * process holds that was opened against the old one.
 *
 * Written only if the connection is still what was read, so an administrator who
 * edited it meanwhile is not overwritten by a search that began before they did.
 * False when it changed underneath.
 */
async function repoint(
    row: FollowedRow,
    to: string,
    identity: who.RememberedIdentity | null
): Promise<boolean> {
    const config = JSON.parse(row.config) as StorageConfig & { host: string };
    const next = JSON.stringify({ ...config, host: to });
    const updated = await prisma.storageConnection.updateMany({
        where: { id: row.id, config: row.config },
        data: { config: next, deviceIdentity: identity === null ? Prisma.DbNull : { ...identity } }
    });
    if (updated.count === 0) return false;
    await settled(row.id, to);
    return true;
}

/** Everything that follows a connection changing address: the sessions and
 *  mount opened against the old one are dropped, the minute of "it failed" that
 *  uploads remember is forgotten, and the files kept here meanwhile start moving
 *  back. Loaded when needed: those modules import this one. */
async function settled(connectionId: string, address: string): Promise<void> {
    verified.set(`${connectionId}|${address}`, Date.now());
    await import("@/lib/storage-service")
        .then((service) => service.forgetConnectionState(connectionId))
        .catch(() => undefined);
    await import("@/lib/storage-target")
        .then((target) => target.forgetStorageFailure(connectionId))
        .catch(() => undefined);
    void import("@/lib/storage-returns")
        .then((returns) => returns.returnFallbackFiles({ only: connectionId }))
        .catch(() => undefined);
}

// --- an address somebody typed -------------------------------------------------

/** What checking a typed address found. */
export type AddressCheck =
    /** It is the remembered device: safe to use. */
    | { readonly kind: "same"; readonly identity: who.DeviceIdentity }
    /** Nothing remembered to compare with; this is who answers there. Using it
     *  is a person's decision, and it is asked for. */
    | {
          readonly kind: "unproven";
          readonly identity: who.DeviceIdentity;
          readonly label: string | null;
      }
    /** A different device answers there. */
    | { readonly kind: "different"; readonly label: string | null }
    /** Nothing answers there on 445, or what does is not an SMB server. */
    | { readonly kind: "silent"; readonly reason: "closed" | "refused" };

/** Who answers at an address, judged against what the connection remembers. */
export async function checkAddress(row: FollowedRow, address: string): Promise<AddressCheck> {
    const seen = await observe(address, { withMac: true });
    if (!seen.answered) return { kind: "silent", reason: seen.reason };
    const remembered = who.readRemembered(row.deviceIdentity);
    if (!remembered || !who.canConfirm(remembered)) {
        return { kind: "unproven", identity: seen.identity, label: who.deviceLabel(seen.identity) };
    }
    const { verdict, identity } = await judge(remembered, address, seen.identity);
    return verdict === "same"
        ? { kind: "same", identity }
        : { kind: "different", label: who.deviceLabel(identity) };
}

/** An address edit refused because the device there is not the one the
 *  connection's password belongs to. Caught by the screens and said in the
 *  reader's language. */
export class AddressRefused extends Error {
    constructor(
        public readonly check: "different" | "silent",
        public readonly address: string,
        public readonly label: string | null
    ) {
        super(
            check === "different"
                ? `A different device answers at ${address}${label ? ` (${label})` : ""}`
                : `Nothing answers at ${address}`
        );
        this.name = "AddressRefused";
    }
}

/**
 * What an edited connection should remember, when its address changes.
 *
 * - `undefined`: leave it as it is (the address did not change).
 * - `null`: forget it, to be learned again the next time the credentials work.
 *   For new credentials (whoever typed them is describing the device anew) and
 *   for a connection that had nothing to compare with.
 * - an identity: the same device, at its new address.
 *
 * Throws `AddressRefused` when the connection keeps its stored password and the
 * device at the new address is not the one that password belongs to - or
 * nothing is there to say so.
 */
export async function identityForEdit(
    row: FollowedRow,
    next: { kind: string; host?: unknown },
    newCredentials: boolean
): Promise<who.RememberedIdentity | null | undefined> {
    if (!isFollowedKind(row.kind)) return undefined;
    const before = addressOf(row);
    const after = typeof next.host === "string" ? next.host.trim() : null;
    if (!after || after === before) return undefined;
    if (newCredentials) return null;
    const remembered = who.readRemembered(row.deviceIdentity);
    if (!remembered || !who.canConfirm(remembered) || !isLocalAddress(after)) return null;
    const check = await checkAddress(row, after);
    if (check.kind === "same")
        return who.mergeIdentity(remembered, check.identity, after, new Date());
    if (check.kind === "different") throw new AddressRefused("different", after, check.label);
    if (check.kind === "silent") throw new AddressRefused("silent", after, null);
    return null;
}

/**
 * Move a connection to an address somebody chose, once `checkAddress` has said
 * it may: the device is the remembered one, or nothing was remembered and the
 * person accepted the device that answers. That device is the one remembered
 * from now on.
 */
export async function moveToAddress(
    row: FollowedRow,
    address: string,
    identity: who.DeviceIdentity
): Promise<boolean> {
    const remembered = who.readRemembered(row.deviceIdentity);
    const same =
        remembered !== null &&
        who.canConfirm(remembered) &&
        who.compareIdentity(remembered, identity) === "same";
    const merged = who.mergeIdentity(same ? remembered : null, identity, address, new Date());
    return repoint(row, address, who.canConfirm(merged) ? merged : null);
}

/** What the uploads screen shows about one followed storage. */
export interface WhereaboutsView {
    readonly id: string;
    readonly name: string;
    readonly address: string;
    readonly remembered: {
        readonly mac: string | null;
        readonly label: string | null;
        readonly seenAt: string;
    } | null;
    readonly last: SearchRecord | null;
}

/** Every storage this follows, for the uploads screen. */
export async function listWhereabouts(): Promise<WhereaboutsView[]> {
    const rows = await prisma.storageConnection.findMany({
        where: { kind: { in: [...FOLLOWED_KINDS] } },
        orderBy: { createdAt: "asc" },
        select: { id: true, name: true, kind: true, config: true, deviceIdentity: true }
    });
    return rows.filter(isFollowable).map((row) => {
        const remembered = who.readRemembered(row.deviceIdentity);
        return {
            id: row.id,
            name: row.name,
            address: addressOf(row)!,
            remembered:
                remembered && who.canConfirm(remembered)
                    ? {
                          mac: remembered.mac ?? null,
                          label: remembered.netbiosName ?? remembered.dnsName ?? null,
                          seenAt: remembered.seenAt
                      }
                    : null,
            last: lastSearch(row.id)
        };
    });
}

/**
 * The scheduled look: every followed storage that remembers its device is asked
 * whether it is still where it was, and looked for when it is not.
 *
 * Without it, a NAS that moved overnight is only noticed by the first upload or
 * photo that fails in the morning - which is somebody's failed upload.
 */
export async function checkWhereabouts(): Promise<void> {
    const rows = await prisma.storageConnection.findMany({
        where: {
            kind: { in: [...FOLLOWED_KINDS] },
            NOT: { deviceIdentity: { equals: Prisma.DbNull } }
        },
        select: { id: true, name: true, kind: true, config: true, deviceIdentity: true }
    });
    for (const row of rows) {
        if (!isFollowable(row)) continue;
        const remembered = who.readRemembered(row.deviceIdentity);
        if (!remembered || !who.canConfirm(remembered)) continue;
        const address = addressOf(row)!;
        const seen = await observe(address);
        if (seen.answered && (await judge(remembered, address, seen.identity)).verdict === "same") {
            continue;
        }
        await searchFor(row.id).catch(() => undefined);
    }
}
