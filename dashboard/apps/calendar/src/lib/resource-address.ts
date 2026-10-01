/**
 * The address a room or a piece of equipment is invited at.
 *
 * A room is a calendar, not a mailbox, so its address must never be deliverable:
 * `.invalid` is reserved by RFC 2606 and resolves nowhere, so a copy of an
 * invitation that leaks into a mail program or a provider cannot reach anybody.
 * The calendar id inside it is what the server reads back. This is the only
 * place the format is written or read.
 *
 * Pure: shared by screens and server.
 */

const DOMAIN = "resource.invalid";
const PATTERN =
    /^room-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})@resource\.invalid$/;

/** The address a resource calendar is invited at. */
export function resourceAddress(calendarId: string): string {
    return `room-${calendarId.toLowerCase()}@${DOMAIN}`;
}

/** The calendar a resource address names, or null for any other address. */
export function resourceIdOf(email: string): string | null {
    return PATTERN.exec(email.trim().toLowerCase())?.[1] ?? null;
}
