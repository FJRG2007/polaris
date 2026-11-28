/**
 * Linking a till, tablet or handheld to a venue, the way a TV signs in
 * (RFC 8628's shape): the device shows a short code and its QR, somebody who
 * runs the venue approves it from their own screen, and the device's next poll
 * collects a token of its own. The admin's session never reaches the device.
 *
 * Pure: codes are made from random bytes the caller passes in, so the server
 * makes them from `crypto.randomBytes` and the tests from fixed ones.
 */

/** No 0/O, 1/I/L: read aloud or typed off a screen, nothing is mistaken. */
export const USER_CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export const USER_CODE_LENGTH = 8;
/** A code nobody approved is dropped after this. */
export const LINK_TTL_MS = 10 * 60_000;
/** The device may ask again this often; faster polls are told to slow down. */
export const POLL_INTERVAL_MS = 4_000;
/** Seen-at is written at most this often per device, not on every request. */
export const SEEN_EVERY_MS = 60_000;
export const DEVICE_COOKIE = "polaris_hospitality_device";

/**
 * A code from random bytes, without modulo bias: a byte that would favour the
 * first letters of the alphabet is skipped. Null when the bytes ran out, so
 * the caller asks for more rather than getting a short code.
 */
export function userCodeFrom(bytes: Uint8Array): string | null {
    const limit = 256 - (256 % USER_CODE_ALPHABET.length);
    let code = "";
    for (const byte of bytes) {
        if (byte >= limit) continue;
        code += USER_CODE_ALPHABET[byte % USER_CODE_ALPHABET.length];
        if (code.length === USER_CODE_LENGTH) return code;
    }
    return null;
}

/** What somebody typed, as stored: upper case, no spaces or dashes; null when it cannot be a code. */
export function normalizeUserCode(typed: string): string | null {
    const code = typed.toUpperCase().replace(/[\s-]/g, "");
    if (code.length !== USER_CODE_LENGTH) return null;
    return [...code].every((c) => USER_CODE_ALPHABET.includes(c)) ? code : null;
}

/** Shown in two halves, the way it is read out: "ABCD-EFGH". */
export function displayUserCode(code: string): string {
    return `${code.slice(0, 4)}-${code.slice(4)}`;
}

export type PollAnswer = "pending" | "slowDown" | "expired" | "approved" | "used";

/** What a poll of a link gets, given its state and the time now. */
export function pollAnswer(
    link: { expiresAt: Date; approvedAt: Date | null; deviceId: string | null; lastPolledAt: Date | null },
    now: Date
): PollAnswer {
    if (link.deviceId) return "used";
    if (link.expiresAt.getTime() <= now.getTime()) return "expired";
    if (link.approvedAt) return "approved";
    if (link.lastPolledAt && now.getTime() - link.lastPolledAt.getTime() < POLL_INTERVAL_MS) return "slowDown";
    return "pending";
}
