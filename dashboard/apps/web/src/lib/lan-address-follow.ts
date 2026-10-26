/**
 * Following this server's own address on the local network.
 *
 * A DHCP lease that moves, a switch from cable to WiFi, or the whole machine
 * carried to another network gives the server a new private address with nobody
 * at a terminal to tell Polaris. The address itself is always read live (the mDNS
 * responder republishes it within seconds, see `host-address.ts`); this pass is
 * for what was built on the old one and does not follow on its own:
 *
 * - the network filter's DNS server, whose port 53 is bound to one address and
 *   cannot start without it (`dns-blocker/service.ts#followHostAddress`);
 * - the local certificate, whose names include the addresses a browser types;
 * - the people who reach Polaris by its address, who are told where it is now.
 *
 * Run as a leased scheduled job (`lan-address-follow`), first at boot, so an
 * install updated after it already moved is repaired the first time it starts.
 * A pass that finds nothing changed reads one file and one setting, plus two rows
 * when the network filter is on.
 */

import { z } from "zod";
import { prisma } from "@polaris/db";
import * as notices from "@/lib/notification-service";
import { wordsFor } from "@/lib/notifications/notice-words";
import { getSetting, setSetting } from "@/lib/setting-store";
import { getHostLanIp, getHostLanIps } from "@/lib/host-address";

/** The address the last pass saw. Written only by this module. */
export const LAN_ADDRESS_KEY = "network.lanAddress";
/** The moves seen, newest first, for a support question. */
export const LAN_HISTORY_KEY = "network.lanAddressHistory";
const HISTORY_MAX = 10;
export const LAN_MOVED_TYPE = "network.lan-address-moved";

export type LanAddressChange =
    | { readonly kind: "none" }
    | { readonly kind: "first"; readonly to: string }
    | { readonly kind: "moved"; readonly from: string; readonly to: string };

/**
 * What the address did since the last pass. An unknown current address is no
 * change: the responder's file is briefly missing while it starts, and that is not
 * the machine leaving the network. Neither is a last address the machine still
 * holds: on cable and WiFi the preferred one follows the route order, while
 * everything built on the other keeps answering. Pure.
 */
export function lanAddressChange(
    last: string | null,
    current: string | null,
    held: readonly string[] = []
): LanAddressChange {
    if (!current || current === last || (last && held.includes(last))) return { kind: "none" };
    if (!last) return { kind: "first", to: current };
    return { kind: "moved", from: last, to: current };
}

export interface LanFollowSteps {
    readonly current: () => Promise<string | null>;
    /** Every address the machine holds now. */
    readonly held: () => Promise<string[]>;
    readonly read: (key: string) => Promise<string | null>;
    readonly write: (key: string, value: string) => Promise<void>;
    /** Move the DNS server; null when it had nothing to move. */
    readonly dns: () => Promise<{ from: string; to: string } | null>;
    readonly certificate: () => Promise<void>;
    readonly announce: (from: string, to: string, dnsMoved: boolean) => Promise<void>;
}

export interface LanFollowResult {
    readonly change: LanAddressChange;
    readonly dnsMoved: boolean;
}

/**
 * One pass. Every step after the address is read is best-effort and isolated: a
 * DNS server that does not come back must not keep the certificate on the old
 * address, nor the operator from being told.
 *
 * The DNS server is checked on every pass, not only on a move: it is the one
 * consumer that can be left behind by a pass that failed half-way, or by an
 * install that moved before this existed.
 */
export async function followLanAddress(
    steps: LanFollowSteps = defaultSteps()
): Promise<LanFollowResult> {
    const current = await steps.current().catch(() => null);
    const held = await steps.held().catch((): string[] => []);
    const last = await steps.read(LAN_ADDRESS_KEY).catch(() => null);
    const change = lanAddressChange(last, current, held);
    if (change.kind !== "none") await steps.write(LAN_ADDRESS_KEY, change.to);

    const dns = await steps.dns().catch((error: unknown) => {
        console.error(
            "polaris: the network filter could not follow this machine's address:",
            error
        );
        return null;
    });
    if (change.kind !== "moved") return { change, dnsMoved: dns !== null };

    console.info(`polaris: this machine's LAN address moved from ${change.from} to ${change.to}`);
    await recordMove(steps, change.from, change.to).catch(() => undefined);
    await steps
        .certificate()
        .catch((error: unknown) =>
            console.error("polaris: local certificate not reissued:", error)
        );
    await steps
        .announce(change.from, change.to, dns !== null)
        .catch((error: unknown) => console.error("polaris: address move not announced:", error));
    return { change, dnsMoved: dns !== null };
}

async function recordMove(steps: LanFollowSteps, from: string, to: string): Promise<void> {
    let history: unknown[] = [];
    try {
        const parsed: unknown = JSON.parse((await steps.read(LAN_HISTORY_KEY)) ?? "[]");
        if (Array.isArray(parsed)) history = parsed;
    } catch {
        // An unreadable history starts again.
    }
    const entry = { from, to, at: new Date().toISOString() };
    await steps.write(LAN_HISTORY_KEY, JSON.stringify([entry, ...history].slice(0, HISTORY_MAX)));
}

/** Told to whoever administers this Polaris: the address is instance-wide. */
async function announceMove(from: string, to: string, dnsMoved: boolean): Promise<void> {
    const admins = await prisma.user.findMany({ where: { isAdmin: true }, select: { id: true } });
    for (const { id: userId } of admins) {
        const t = await wordsFor(userId, "notices");
        await notices.createNotification({
            userId,
            type: LAN_MOVED_TYPE,
            title: t("lanAddress.movedTitle", { to }),
            body: dnsMoved
                ? t("lanAddress.movedBodyDns", { from, to })
                : t("lanAddress.movedBody", { from, to }),
            level: "info",
            metadata: { from, to }
        });
    }
}

function defaultSteps(): LanFollowSteps {
    return {
        current: getHostLanIp,
        held: getHostLanIps,
        read: getSetting,
        write: (key, value) => setSetting(key, value),
        dns: async () => (await import("@/lib/dns-blocker/service")).followHostAddress(),
        certificate: async () => (await import("@/lib/local-ca-service")).ensureLocalCa(),
        announce: announceMove
    };
}

/** How long a move stays on screen for the people who manage this Polaris. Long
 *  enough to be seen after a weekend away; short enough not to be furniture. */
export const LAN_MOVE_SHOWN_MS = 7 * 24 * 60 * 60 * 1000;

const lanMoveSchema = z.object({
    from: z.string().min(1).max(64),
    to: z.string().min(1).max(64),
    at: z.string().min(1).max(64)
});

export type LanMove = z.infer<typeof lanMoveSchema>;

/**
 * The newest recorded move, while it is recent enough to show. The history is
 * stored JSON an older build may have written, so anything that does not parse
 * is no move rather than an error. Pure.
 */
export function recentLanMove(
    rawHistory: string | null,
    now: number = Date.now()
): LanMove | null {
    let parsed: unknown;
    try {
        parsed = JSON.parse(rawHistory ?? "[]");
    } catch {
        return null;
    }
    if (!Array.isArray(parsed) || parsed.length === 0) return null;
    const newest = lanMoveSchema.safeParse(parsed[0]);
    if (!newest.success) return null;
    const at = Date.parse(newest.data.at);
    if (Number.isNaN(at) || now - at > LAN_MOVE_SHOWN_MS || at - now > 60_000) return null;
    return newest.data;
}
