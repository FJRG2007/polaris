/**
 * The one-time keys a person made to add a device to the VPN, as their account
 * screen lists them. Pure: the control server's answer goes in, rows come out.
 *
 * The value of a key is never handed back after it was made. A row carries the
 * start of it, enough to match it against what was pasted somewhere, and the id
 * the control server names it by.
 */

import type { PreAuthKey } from "./headscale-client";

export type DeviceKeyState = "unused" | "used" | "expired";

export interface DeviceKey {
    readonly id: string;
    /** The start of the key, for telling two apart. */
    readonly hint: string;
    readonly state: DeviceKeyState;
    readonly createdAt: string | null;
    readonly expiresAt: string | null;
}

/** How much of a key is shown. */
const HINT_LENGTH = 12;

function hintOf(key: string): string {
    return key.length > HINT_LENGTH ? `${key.slice(0, HINT_LENGTH)}...` : key;
}

/** Whether a key can still sign a device in. */
export function keyState(key: PreAuthKey, now: number): DeviceKeyState {
    if (key.expiration !== null && Date.parse(key.expiration) <= now) return "expired";
    // A reusable key stays usable after its first device.
    if (key.used && !key.reusable) return "used";
    return "unused";
}

/**
 * The keys that belong to `userId`, newest first. A key the control server
 * names another user for is left out: newer servers answer every user's keys
 * whatever was asked. Keys carrying tags are the ones a private network's
 * gateway signs in with, made and spent by Polaris itself, and are left out too.
 */
export function deviceKeysOf(
    keys: readonly PreAuthKey[],
    userId: string,
    now: number
): DeviceKey[] {
    return keys
        .filter((key) => (key.user ? key.user.id === userId : true) && key.aclTags.length === 0)
        .map((key) => ({
            id: key.id,
            hint: hintOf(key.key),
            state: keyState(key, now),
            createdAt: key.createdAt,
            expiresAt: key.expiration
        }))
        .sort((left, right) => (right.createdAt ?? "").localeCompare(left.createdAt ?? ""));
}

/** The command that connects a router or server with a key. The device runs
 *  the Tailscale client, which is what reads it. */
export function connectCommand(server: string, key: string): string {
    return `tailscale up --login-server=${server} --authkey=${key}`;
}
