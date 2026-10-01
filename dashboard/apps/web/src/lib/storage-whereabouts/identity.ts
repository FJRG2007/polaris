/**
 * Who a storage on the local network is, as opposed to where it is.
 *
 * A NAS reached by address is reached by an address its router lent it. When the
 * lease changes - a reboot, a router swap, a lease that simply ran out - the box
 * is still on the shelf, still answering, and Polaris keeps dialling a number
 * nobody answers on. Worse, the router can lend that number to something else,
 * and then Polaris hands the stored password to whatever picked it up.
 *
 * So a storage remembers what the device it talked to looked like: the hardware
 * address the host saw it under, and what its SMB server says about itself before
 * anybody signs in (its server GUID and its NetBIOS and DNS names). Those are what
 * "the same device" is checked against, never the address.
 *
 * Pure: everything here is a value in and a value out, so the rule that decides
 * whether credentials may go somewhere is tested without a network.
 */

import { z } from "zod";
import { isLocalAddress } from "@polaris/core";

/** What a device said about itself, or what the host's neighbour table said
 *  about it. Every field is optional because every source can be missing: the
 *  limited edition cannot read the neighbour table, and an SMB server can leave
 *  any name out of its challenge. */
export interface DeviceIdentity {
    /** The hardware address, as `aa:bb:cc:dd:ee:ff`. */
    readonly mac?: string;
    /** The SMB server's GUID from its NEGOTIATE answer, as 32 lowercase hex digits. */
    readonly serverGuid?: string;
    /** Its NetBIOS computer name, uppercase. */
    readonly netbiosName?: string;
    /** Its DNS computer name, lowercase. */
    readonly dnsName?: string;
}

/** What is stored on the connection: the identity, plus where and when it was
 *  last seen answering as itself. */
export interface RememberedIdentity extends DeviceIdentity {
    readonly address: string;
    /** ISO time. */
    readonly seenAt: string;
}

const MAC = /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/;
const GUID = /^[0-9a-f]{32}$/;

/** The stored column, read defensively: it is JSON an older build may have
 *  written, and a shape that does not parse is "nothing remembered", never a
 *  reason to fail a connection. */
export const rememberedIdentitySchema = z.object({
    mac: z.string().regex(MAC).optional(),
    serverGuid: z.string().regex(GUID).optional(),
    netbiosName: z.string().min(1).max(64).optional(),
    dnsName: z.string().min(1).max(255).optional(),
    address: z.string().min(1).max(255),
    seenAt: z.string().min(1).max(64)
});

export function readRemembered(value: unknown): RememberedIdentity | null {
    const parsed = rememberedIdentitySchema.safeParse(value);
    return parsed.success ? parsed.data : null;
}

/** One normal spelling of a hardware address, or undefined for one that is not
 *  usable - including the all-zero address an incomplete neighbour entry shows. */
export function normalizeMac(value: string | undefined | null): string | undefined {
    if (!value) return undefined;
    const hex = value.toLowerCase().replace(/[^0-9a-f]/g, "");
    if (hex.length !== 12 || /^0+$/.test(hex) || /^f+$/.test(hex)) return undefined;
    return hex.match(/../g)!.join(":");
}

/** Identity fields in their stored spelling, empty ones dropped. */
export function normalizeIdentity(identity: DeviceIdentity): DeviceIdentity {
    const mac = normalizeMac(identity.mac);
    const serverGuid = identity.serverGuid?.toLowerCase().replace(/[^0-9a-f]/g, "");
    const netbiosName = identity.netbiosName?.trim().toUpperCase();
    const dnsName = identity.dnsName?.trim().toLowerCase().replace(/\.$/, "");
    return {
        ...(mac ? { mac } : {}),
        // An all-zero GUID is what a server sends when it has none to give.
        ...(serverGuid && GUID.test(serverGuid) && !/^0+$/.test(serverGuid) ? { serverGuid } : {}),
        ...(netbiosName ? { netbiosName } : {}),
        ...(dnsName ? { dnsName } : {})
    };
}

/** Whether there is anything in an identity that could tell one device from
 *  another. A name alone is not that: two NAS boxes out of the same carton are
 *  called the same thing until somebody renames one. */
export function canConfirm(identity: DeviceIdentity | null | undefined): boolean {
    if (!identity) return false;
    const normal = normalizeIdentity(identity);
    return Boolean(normal.mac || normal.serverGuid);
}

export type Verdict =
    /** It is the device that was remembered. */
    | "same"
    /** It is positively somebody else. */
    | "different"
    /** Nothing either way: no hardware address and no GUID to compare. */
    | "unknown";

/**
 * Whether what answers now is the device that was remembered.
 *
 * The two hard facts are the hardware address and the SMB server GUID. A name is
 * a tie-breaker, never a proof. The rule:
 *
 * - at least one hard fact has to agree. A device that only shares a name is
 *   not confirmed, because a name is exactly what an impostor would copy and
 *   exactly what two identical boxes share.
 * - a hard fact that disagrees is forgiven only when the name agrees too. That
 *   covers the two honest changes: a NAS with two network ports moved to the
 *   other one (a new hardware address, the same GUID), and a server whose GUID
 *   is regenerated on restart (a new GUID, the same hardware address).
 * - one fact agreeing and one disagreeing under a different name is refused. A
 *   device that renamed itself AND changed its GUID is rare, and the cost of
 *   being wrong is a password handed to a stranger.
 */
export function compareIdentity(
    remembered: DeviceIdentity | null | undefined,
    observed: DeviceIdentity | null | undefined
): Verdict {
    if (!remembered || !observed) return "unknown";
    const was = normalizeIdentity(remembered);
    const now = normalizeIdentity(observed);

    let agree = 0;
    let conflict = 0;
    for (const key of ["mac", "serverGuid"] as const) {
        const a = was[key];
        const b = now[key];
        if (!a || !b) continue;
        if (a === b) agree += 1;
        else conflict += 1;
    }

    const wasName = nameOf(was);
    const nowName = nameOf(now);
    const nameAgrees = Boolean(wasName && nowName && wasName === nowName);
    const nameConflicts = Boolean(wasName && nowName && wasName !== nowName);

    if (agree === 0) {
        // Nothing hard agreed. A hard fact that disagreed is enough to say no;
        // a name that disagrees on its own is too (it is a different server
        // saying so); anything else is simply not known.
        if (conflict > 0 || nameConflicts) return "different";
        return "unknown";
    }
    if (conflict === 0) return "same";
    return nameAgrees ? "same" : "different";
}

function nameOf(identity: DeviceIdentity): string | undefined {
    return identity.netbiosName ?? identity.dnsName?.split(".")[0]?.toUpperCase();
}

/**
 * Fold a fresh observation into what was remembered, once it is known to be the
 * same device: what was missing is filled in and what changed honestly (a GUID
 * regenerated, the other network port) is replaced.
 */
export function mergeIdentity(
    remembered: DeviceIdentity | null | undefined,
    observed: DeviceIdentity,
    address: string,
    seenAt: Date
): RememberedIdentity {
    const was = remembered ? normalizeIdentity(remembered) : {};
    const now = normalizeIdentity(observed);
    return { ...was, ...now, address, seenAt: seenAt.toISOString() };
}

/** Every other host address on the /24 an address sits on, nearest first, so a
 *  device that moved a few leases along is found in the first round. Empty for
 *  an address that is not on a private network: Polaris never sweeps the
 *  internet looking for a NAS. */
export function neighbourhoodOf(address: string): string[] {
    if (!isLocalAddress(address)) return [];
    const parts = address.split(".").map(Number);
    const prefix = parts.slice(0, 3).join(".");
    const own = parts[3]!;
    const order: number[] = [];
    for (let step = 1; step < 255; step += 1) {
        if (own + step <= 254) order.push(own + step);
        if (own - step >= 1) order.push(own - step);
    }
    return order.map((last) => `${prefix}.${last}`);
}

/** How a device is named to a person: its name when it gave one, else its
 *  hardware address, else nothing. */
export function deviceLabel(identity: DeviceIdentity | null | undefined): string | null {
    if (!identity) return null;
    return identity.netbiosName ?? identity.dnsName ?? normalizeMac(identity.mac) ?? null;
}
