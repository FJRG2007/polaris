/**
 * Gree's LAN protocol: finding units, binding to one, reading it and telling it
 * what to do.
 *
 * Written from `greeclimate` (`network.py`, `discovery.py`, `device.py`), the
 * library behind Home Assistant's `gree` integration:
 *
 * - **Scan**: `{"t":"scan"}` in the clear to port 7000. A unit answers with a
 *   `pack` sealed under the generic key: `t: "dev"`, its MAC, name, brand,
 *   model and firmware.
 * - **Bind**: `{"t":"bind","mac":...,"uid":0}` sealed under the generic key,
 *   `i: 1`. The unit answers `t: "bindok"` with its own key. A unit that does
 *   not answer the V1 key is asked again in V2 (GCM), as the library does.
 * - **Status**: `{"t":"status","mac":...,"cols":[...]}` under the unit's key,
 *   `i: 0`; the answer is `t: "dat"` with `cols` and `dat` side by side.
 * - **Command**: `{"t":"cmd","mac":...,"opt":[...],"p":[...]}`; the answer is
 *   `t: "res"`, with the values under `val` or `p`.
 *
 * Every message is wrapped the same way: `cid: "app"`, `t: "pack"`, `uid: 0`,
 * `tcid` the unit's MAC, and the sealed `pack` (plus `tag` in V2).
 *
 * Server-only.
 */

import { z } from "zod";
import { DriverError } from "../drivers/contract";
import { greeExchange, type GreeDatagram } from "./gree-udp";
import { GREE_GENERIC_KEYS, openGree, sealGree, type GreeCipher } from "./gree-crypto";

/** How long a scan listens. The library waits two seconds and Home Assistant
 *  eight; units on wifi answer well inside three. */
export const SCAN_WINDOW_MS = 3000;
/** How long one bind attempt is given, per cipher. */
const BIND_WINDOW_MS = 4000;
/** How long a read or a command is given. A unit on a busy access point is
 *  slow now and then, and is asked once more before it counts as gone. */
const REQUEST_WINDOW_MS = 3000;

/** A unit as a scan found it. */
export interface GreeFound {
    readonly address: string;
    readonly mac: string;
    readonly name: string;
    readonly brand: string;
    readonly model: string;
    readonly version: string;
}

/** A unit Polaris is bound to: where it is and the key it gave. */
export const greeUnitSchema = z.object({
    mac: z.string().regex(/^[0-9a-f]{12}$/i),
    address: z.string().min(7).max(15),
    key: z.string().length(16),
    cipher: z.enum(["v1", "v2"]),
    name: z.string().max(120),
    model: z.string().max(120)
});

export type GreeUnit = z.infer<typeof greeUnitSchema>;

/** What the unit reports, by its own column names. */
export type GreeStatus = Readonly<Record<string, unknown>>;

/** The wrapper every message travels in. */
export function greeMessage(
    mac: string,
    inner: Record<string, unknown>,
    key: string,
    cipher: GreeCipher,
    bootstrap: boolean
): Record<string, unknown> {
    const sealed = sealGree(inner, key, cipher);
    return {
        cid: "app",
        i: bootstrap ? 1 : 0,
        t: "pack",
        uid: 0,
        tcid: mac,
        pack: sealed.pack,
        ...(sealed.tag ? { tag: sealed.tag } : {})
    };
}

const envelopeSchema = z.object({ pack: z.string().min(1).max(8192) }).passthrough();

/** The `pack` of a datagram, opened, or null for anything that is not one. */
function openReply(
    reply: GreeDatagram,
    key: string,
    cipher: GreeCipher
): Record<string, unknown> | null {
    let outer: unknown;
    try {
        outer = JSON.parse(reply.data.toString("utf8"));
    } catch {
        return null;
    }
    const envelope = envelopeSchema.safeParse(outer);
    if (!envelope.success) return null;
    const inner = openGree(envelope.data.pack, key, cipher);
    return inner && typeof inner === "object" && !Array.isArray(inner)
        ? (inner as Record<string, unknown>)
        : null;
}

const scanSchema = z.object({
    t: z.literal("dev"),
    mac: z.string().optional(),
    cid: z.string().optional(),
    name: z.string().optional(),
    brand: z.string().optional(),
    model: z.string().optional(),
    ver: z.string().optional()
});

/** One scan answer, read, or null. Tried under both generic keys. */
export function readScanReply(reply: GreeDatagram): GreeFound | null {
    for (const cipher of ["v1", "v2"] as const) {
        const parsed = scanSchema.safeParse(openReply(reply, GREE_GENERIC_KEYS[cipher], cipher));
        if (!parsed.success) continue;
        // `discovery.py`: the MAC, or the cid where a unit left it out.
        const mac = (parsed.data.mac || parsed.data.cid || "").toLowerCase().replace(/[:-]/g, "");
        if (!/^[0-9a-f]{12}$/.test(mac)) return null;
        return {
            address: reply.address,
            mac,
            name: (parsed.data.name ?? "").trim(),
            brand: (parsed.data.brand ?? "").trim(),
            model: (parsed.data.model ?? "").trim(),
            version: (parsed.data.ver ?? "").trim()
        };
    }
    return null;
}

/** Ask these addresses who is a Gree unit. Each unit once, however it was
 *  reached. */
export async function scanGree(
    targets: readonly string[],
    windowMs = SCAN_WINDOW_MS
): Promise<GreeFound[]> {
    if (targets.length === 0) return [];
    const replies = await greeExchange({
        targets,
        payload: Buffer.from(JSON.stringify({ t: "scan" })),
        windowMs
    });
    const found = new Map<string, GreeFound>();
    for (const reply of replies) {
        const unit = readScanReply(reply);
        if (unit && !found.has(unit.mac)) found.set(unit.mac, unit);
    }
    return [...found.values()];
}

/** Send one sealed message to one unit and wait for the answer of this kind. */
async function request(
    address: string,
    mac: string,
    inner: Record<string, unknown>,
    key: string,
    cipher: GreeCipher,
    expect: string,
    windowMs: number,
    bootstrap = false
): Promise<Record<string, unknown> | null> {
    const payload = Buffer.from(JSON.stringify(greeMessage(mac, inner, key, cipher, bootstrap)));
    let answer: Record<string, unknown> | null = null;
    // Answers come back sealed under the key the request used, except a bind
    // answer, which is under the generic key the bind was sent with.
    await greeExchange({
        targets: [address],
        payload,
        windowMs,
        until: (reply) => {
            const opened = openReply(reply, key, cipher);
            if (opened?.t !== expect) return false;
            answer = opened;
            return true;
        }
    });
    return answer;
}

/**
 * Bind to a unit: its own key, and which generation of cipher it speaks.
 *
 * V1 first and V2 when V1 goes unanswered, as `Device.bind` does. Null when it
 * answered neither - a unit switched off at the wall, or not a Gree after all.
 */
export async function bindGree(
    found: Pick<GreeFound, "address" | "mac">
): Promise<{ key: string; cipher: GreeCipher } | null> {
    for (const cipher of ["v1", "v2"] as const) {
        const answer = await request(
            found.address,
            found.mac,
            { t: "bind", mac: found.mac, uid: 0 },
            GREE_GENERIC_KEYS[cipher],
            cipher,
            "bindok",
            BIND_WINDOW_MS,
            true
        );
        const key = answer?.key;
        if (typeof key === "string" && Buffer.byteLength(key) === 16) return { key, cipher };
    }
    return null;
}

/** The columns read on every sync (`device.Props`, the air conditioner's half). */
export const STATUS_COLUMNS = [
    "Pow",
    "Mod",
    "SetTem",
    "TemSen",
    "TemUn",
    "TemRec",
    "WdSpd",
    "Air",
    "Blo",
    "Health",
    "SwhSlp",
    "Lig",
    "SwingLfRig",
    "SwUpDn",
    "Quiet",
    "Tur",
    "StHt",
    "SvSt",
    "hid"
] as const;

/** Read a unit. Asked twice before it counts as not answering. */
export async function readGree(
    unit: Pick<GreeUnit, "address" | "mac" | "key" | "cipher">,
    columns: readonly string[] = STATUS_COLUMNS
): Promise<GreeStatus> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
        const answer = await request(
            unit.address,
            unit.mac,
            { t: "status", mac: unit.mac, cols: [...columns] },
            unit.key,
            unit.cipher,
            "dat",
            REQUEST_WINDOW_MS
        );
        if (!answer) continue;
        const cols = answer.cols;
        const values = answer.dat;
        if (!Array.isArray(cols) || !Array.isArray(values)) break;
        const status: Record<string, unknown> = {};
        cols.forEach((column, index) => {
            if (typeof column === "string") status[column] = values[index];
        });
        return status;
    }
    throw new DriverError("The air conditioner did not answer.", "unreachable");
}

/** Tell a unit to set these columns. Asked twice; a unit that answers with
 *  anything but 200 refused it. */
export async function commandGree(
    unit: Pick<GreeUnit, "address" | "mac" | "key" | "cipher">,
    values: Readonly<Record<string, number>>
): Promise<void> {
    const opt = Object.keys(values);
    const p = opt.map((column) => values[column]);
    for (let attempt = 0; attempt < 2; attempt += 1) {
        const answer = await request(
            unit.address,
            unit.mac,
            { t: "cmd", mac: unit.mac, opt, p },
            unit.key,
            unit.cipher,
            "res",
            REQUEST_WINDOW_MS
        );
        if (!answer) continue;
        if (answer.r !== undefined && answer.r !== 200) {
            throw new DriverError("The air conditioner refused that.", "refused");
        }
        return;
    }
    throw new DriverError("The air conditioner did not answer.", "unreachable");
}
