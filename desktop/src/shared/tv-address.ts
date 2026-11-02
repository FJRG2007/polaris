/**
 * The address of a TV, as typed. Shared by the window and the main process, so
 * the field says the same thing the install would refuse.
 */

/** A private IPv4 address: the only kind this will talk ADB to. */
export function readTvAddress(value: unknown): string | null {
    if (typeof value !== "string") return null;
    const typed = value.trim();
    const parts = typed.split(".");
    if (parts.length !== 4 || !parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)) return null;
    const [a, b] = parts.map(Number) as [number, number];
    const isPrivate = a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31);
    return isPrivate ? parts.map(Number).join(".") : null;
}
