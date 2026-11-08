/**
 * A phone used as a game's controller. The game's page opens a pad and shows
 * its code (and a QR of the link that carries it); a phone signed in to Polaris
 * claims it by that code, or with one tap when it is signed in to the same
 * account, and from then on its sticks and buttons reach the game and the
 * game's rumbles reach the phone.
 *
 * Nothing is stored: a pad lives in this process for as long as the game that
 * opened it is listening, the same in-process pattern as the Tasks live bus
 * (`lib/tasks/live.ts`). The registry is held on a `Symbol.for` key so a dev
 * module re-evaluation does not strand the open pads on an old Map.
 */

import { z } from "zod";
import { randomBytes, randomInt } from "node:crypto";

/** How long an unclaimed pad waits for a phone. */
export const PAD_UNCLAIMED_MS = 10 * 60_000;
/** How long a pad outlives its game's stream, so a reconnecting page finds it again. */
export const PAD_RECONNECT_MS = 15_000;
/** Open pads one account may hold at once, and in the whole instance. */
const PER_OWNER = 4;
const TOTAL = 2_000;
const CODE_DIGITS = 6;

/** One snapshot of the phone's controls, in the W3C standard gamepad layout. */
export const padFrameSchema = z.object({
    axes: z.array(z.number().finite().min(-1).max(1)).length(4),
    buttons: z.array(z.number().finite().min(0).max(1)).length(17)
});
export type PadFrame = z.infer<typeof padFrameSchema>;

export const rumbleSchema = z.object({
    strong: z.number().finite().min(0).max(1),
    weak: z.number().finite().min(0).max(1),
    duration: z.number().int().min(1).max(2_000)
});
export type Rumble = z.infer<typeof rumbleSchema>;

export type HostEvent =
    { kind: "input"; frame: PadFrame } | { kind: "phone"; connected: boolean; name: string };
export type PhoneEvent = { kind: "rumble"; rumble: Rumble } | { kind: "closed" };

interface Pad {
    readonly id: string;
    readonly code: string;
    readonly ownerId: string;
    readonly openedAt: number;
    /** The game it was opened for (its id) and the device it is open on, as
     *  the owner's phone lists it; empty when not known. */
    readonly game: string;
    readonly device: string;
    phone: { token: string; userId: string; name: string } | null;
    readonly hosts: Set<(event: HostEvent) => void>;
    readonly phones: Set<(event: PhoneEvent) => void>;
    unheard: ReturnType<typeof setTimeout> | null;
}

const KEY = Symbol.for("polaris.arcade.phone-pads");
const store = globalThis as unknown as Record<symbol, Map<string, Pad> | undefined>;
const pads: Map<string, Pad> = (store[KEY] ??= new Map());

function emit<T>(listeners: Set<(event: T) => void>, event: T) {
    for (const listener of listeners) {
        try {
            listener(event);
        } catch {
            // One dead stream never stops the rest
        }
    }
}

/** Drops pads nobody claimed in time and nobody is listening to. */
function sweep(now = Date.now()) {
    for (const pad of pads.values()) {
        if (!pad.phone && now - pad.openedAt > PAD_UNCLAIMED_MS) closePad(pad.id);
        else if (pad.hosts.size === 0 && now - pad.openedAt > PAD_UNCLAIMED_MS) closePad(pad.id);
    }
}

function freshCode(): string {
    const live = new Set([...pads.values()].map((pad) => pad.code));
    for (;;) {
        const code = String(randomInt(0, 10 ** CODE_DIGITS)).padStart(CODE_DIGITS, "0");
        if (!live.has(code)) return code;
    }
}

/** Opens a pad for `ownerId`, or null where they (or the instance) hold too many. */
export function openPad(
    ownerId: string,
    about: { game?: string; device?: string } = {}
): { id: string; code: string } | null {
    sweep();
    const owned = [...pads.values()].filter((pad) => pad.ownerId === ownerId);
    // The oldest of the owner's pads makes way: a reloaded game tab leaves one behind
    const oldest = owned[0];
    if (owned.length >= PER_OWNER && oldest) closePad(oldest.id);
    if (pads.size >= TOTAL) return null;
    const pad: Pad = {
        id: randomBytes(16).toString("hex"),
        code: freshCode(),
        ownerId,
        openedAt: Date.now(),
        game: about.game ?? "",
        device: about.device ?? "",
        phone: null,
        hosts: new Set(),
        phones: new Set(),
        unheard: null
    };
    pads.set(pad.id, pad);
    return { id: pad.id, code: pad.code };
}

/** Closes a pad and tells its phone so. */
export function closePad(id: string) {
    const pad = pads.get(id);
    if (!pad) return;
    pads.delete(id);
    if (pad.unheard) clearTimeout(pad.unheard);
    emit(pad.phones, { kind: "closed" });
    pad.hosts.clear();
    pad.phones.clear();
}

/** Closes a pad for the account that opened it; false when it is not theirs. */
export function closeOwnedPad(id: string, ownerId: string): boolean {
    if (pads.get(id)?.ownerId !== ownerId) return false;
    closePad(id);
    return true;
}

/** The owner's pads still waiting for a phone, newest first: what the phone offers with one tap. */
export function waitingPads(
    ownerId: string
): { id: string; openedAt: number; game: string; device: string }[] {
    sweep();
    return [...pads.values()]
        .filter((pad) => pad.ownerId === ownerId && !pad.phone)
        .sort((a, b) => b.openedAt - a.openedAt)
        .map((pad) => ({
            id: pad.id,
            openedAt: pad.openedAt,
            game: pad.game,
            device: pad.device
        }));
}

/**
 * A phone claims a pad: by its code (any signed-in reader who can see it) or
 * by its id (only the account that opened it). Returns the token the phone
 * sends its controls with, or null when there is no such pad or it is taken.
 */
export function claimPad(
    by: { code: string } | { id: string },
    phone: { userId: string; name: string }
): { id: string; token: string } | null {
    sweep();
    const pad =
        "code" in by
            ? [...pads.values()].find((candidate) => candidate.code === by.code)
            : pads.get(by.id);
    if (!pad || pad.phone) return null;
    if ("id" in by && pad.ownerId !== phone.userId) return null;
    const token = randomBytes(16).toString("hex");
    pad.phone = { token, userId: phone.userId, name: phone.name };
    emit(pad.hosts, { kind: "phone", connected: true, name: phone.name });
    return { id: pad.id, token };
}

function phonePad(id: string, token: string): Pad | null {
    const pad = pads.get(id);
    return pad?.phone && pad.phone.token === token ? pad : null;
}

/** A frame of the phone's controls for the game; false when the phone no longer holds the pad. */
export function sendInput(id: string, token: string, frame: PadFrame): boolean {
    const pad = phonePad(id, token);
    if (!pad) return false;
    emit(pad.hosts, { kind: "input", frame });
    return true;
}

/** The phone lets go of the pad; the game may offer it again. */
export function releasePad(id: string, token: string) {
    const pad = phonePad(id, token);
    if (!pad) return;
    pad.phone = null;
    emit(pad.phones, { kind: "closed" });
    pad.phones.clear();
    emit(pad.hosts, { kind: "phone", connected: false, name: "" });
}

/** A rumble from the game to its phone; false when the pad is not the owner's. */
export function sendRumble(id: string, ownerId: string, rumble: Rumble): boolean {
    const pad = pads.get(id);
    if (!pad || pad.ownerId !== ownerId) return false;
    emit(pad.phones, { kind: "rumble", rumble });
    return true;
}

/** The game listens to its pad. Returns the unsubscribe, or null when the pad is not the owner's. */
export function listenAsHost(id: string, ownerId: string, listener: (event: HostEvent) => void) {
    const pad = pads.get(id);
    if (!pad || pad.ownerId !== ownerId) return null;
    if (pad.unheard) clearTimeout(pad.unheard);
    pad.unheard = null;
    pad.hosts.add(listener);
    if (pad.phone) listener({ kind: "phone", connected: true, name: pad.phone.name });
    return () => {
        if (!pad.hosts.delete(listener) || pad.hosts.size > 0 || pads.get(pad.id) !== pad) return;
        // The game's page is gone, unless its stream comes back in time
        pad.unheard = setTimeout(() => {
            if (pad.hosts.size === 0) closePad(pad.id);
        }, PAD_RECONNECT_MS);
        pad.unheard.unref?.();
    };
}

/** The phone listens for rumbles. Returns the unsubscribe, or null when the token does not hold the pad. */
export function listenAsPhone(id: string, token: string, listener: (event: PhoneEvent) => void) {
    const pad = phonePad(id, token);
    if (!pad) return null;
    pad.phones.add(listener);
    return () => {
        pad.phones.delete(listener);
    };
}

/** Test seam: forgets every pad. */
export function resetPadsForTests() {
    for (const pad of pads.values()) if (pad.unheard) clearTimeout(pad.unheard);
    pads.clear();
}
