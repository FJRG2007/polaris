/**
 * A game room's code: what one person reads out and another types. Eight
 * characters of Crockford's base32 - no I, L, O or U, so nothing reads as
 * something else - which is 32^8, about 10^12, codes. With joining by code
 * limited per account (`ROOM_JOIN_LIMIT`) that is not a space anybody walks.
 *
 * Shared by the screen and the server: both normalize a typed code the same
 * way before checking it.
 */

import { z } from "zod";

export const ROOM_CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export const ROOM_CODE_LENGTH = 8;

/** How many codes one account may try, and in how long. */
export const ROOM_JOIN_LIMIT = 10;
export const ROOM_JOIN_WINDOW_MS = 10 * 60 * 1000;

/** How many rooms one account may open, and in how long. */
export const ROOM_CREATE_LIMIT = 10;
export const ROOM_CREATE_WINDOW_MS = 10 * 60 * 1000;

/** A typed code in its one stored form: upper case, no spaces or dashes, and
 *  the letters people mistype for digits read as the digits. */
export function normalizeRoomCode(raw: string): string {
    return raw.trim().toUpperCase().replace(/[\s-]/g, "").replace(/[IL]/g, "1").replace(/O/g, "0");
}

export const roomCodeSchema = z
    .string()
    .max(32)
    .transform(normalizeRoomCode)
    .pipe(z.string().regex(new RegExp(`^[${ROOM_CODE_ALPHABET}]{${ROOM_CODE_LENGTH}}$`)));

/** A code as it is shown: two groups of four, easier to read out. */
export function formatRoomCode(code: string): string {
    return `${code.slice(0, 4)}-${code.slice(4)}`;
}
