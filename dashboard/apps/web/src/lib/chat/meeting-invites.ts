/**
 * The ways somebody is asked to a meeting other than being handed its link:
 * by name, by email address, and by a short code they type.
 *
 * Pure, so the screen that collects them and the server that stores them read
 * one set of rules, and a test can hold them without a database.
 *
 * Polaris sends no mail of its own, so an address here is a record that the
 * person was asked - drawn on the host's list as invited - and the invitation
 * itself is text the host copies and sends however they like.
 */

import { z } from "zod";

/** How many people one invitation may name. The room holds eight, and inviting
 *  a hundred people to a room that holds eight is a list nobody can act on. */
export const MOST_INVITED = 50;

/** How many addresses one meeting may hold, for the same reason. */
export const MOST_EMAILS = 50;

/** What an address may be at most (RFC 5321's path limit). */
export const MAX_EMAIL = 254;

/**
 * The characters a join code is made of: capitals and digits with the ones that
 * are read as each other taken out - no 0/O, no 1/I/L - so a code read aloud or
 * copied off a screen is typed right the first time.
 */
export const JOIN_CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

/** Nine of them, shown as three groups of three: 31^9 is about 2.6e13 codes,
 *  which a rate-limited form does not get through. */
export const JOIN_CODE_LENGTH = 9;

/**
 * What somebody typed, as the stored form: capitals, with the spaces and dashes
 * people put in when they copy a grouped code taken out. Null when what is left
 * is not a code at all, which the caller answers like a code that names nothing.
 */
export function normalizeJoinCode(typed: string): string | null {
    const code = typed.toUpperCase().replace(/[\s-]+/g, "");
    if (code.length !== JOIN_CODE_LENGTH) return null;
    for (const char of code) if (!JOIN_CODE_ALPHABET.includes(char)) return null;
    return code;
}

/** A stored code as people read it: ABC-DEF-GHJ. */
export function formatJoinCode(code: string): string {
    return code.match(/.{1,3}/g)?.join("-") ?? code;
}

/** The one form an address is stored and compared in. */
export function normalizeEmail(email: string): string {
    return email.trim().toLowerCase();
}

/** One address, normalized before it is checked. */
export const inviteEmailSchema = z
    .string()
    .transform(normalizeEmail)
    .pipe(z.string().min(1).max(MAX_EMAIL).email());

/** The invitations a new meeting may be created with. */
export const meetingInvitesSchema = z.object({
    userIds: z.array(z.string().uuid()).max(MOST_INVITED).default([]),
    emails: z.array(inviteEmailSchema).max(MOST_EMAILS).default([]),
    joinCode: z.boolean().default(false)
});

export type MeetingInvitesInput = z.input<typeof meetingInvitesSchema>;

/** A typed join code, before it is looked up. */
export const joinCodeInputSchema = z.string().max(32).transform(normalizeJoinCode);

/**
 * Whether these invitations fit the meeting's own rules, as a chat error key,
 * or null when they do. A meeting only open to Polaris accounts takes no
 * addresses: whoever is at the other end of one has, as far as Polaris knows,
 * no account to sign in with, and the link would turn them away.
 */
export function inviteRefusal(input: {
    requireAccount: boolean;
    emails: readonly string[];
}): "errors.meetingEmailsNeedGuests" | null {
    return input.requireAccount && input.emails.length > 0
        ? "errors.meetingEmailsNeedGuests"
        : null;
}
