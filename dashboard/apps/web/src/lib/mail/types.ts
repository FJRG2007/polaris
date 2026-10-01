/**
 * What the senders take. One message shape and one account shape, so adding a
 * provider means writing a send function and nothing else.
 */

import type { MailConfig } from "@polaris/core";

/** A single outbound message. Plain text is required; HTML is the nicer copy of
 *  the same thing, so a client that refuses HTML still gets the content. */
export interface EmailMessage {
    to: string;
    subject: string;
    text: string;
    html?: string;
    /** An iTIP message (RFC 5546) to carry as an invitation, per RFC 6047: a text/calendar part with its METHOD, which mail clients render as Accept/Decline. */
    calendar?: { method: "REQUEST" | "CANCEL" | "REPLY" | "PUBLISH"; ics: string };
}

/** The file name an invitation travels under, whichever provider carries it. */
export const INVITE_FILENAME = "invite.ics";

/** The content type of an invitation part: RFC 6047 requires the METHOD on it. */
export function calendarContentType(calendar: NonNullable<EmailMessage["calendar"]>): string {
    return `text/calendar; charset=utf-8; method=${calendar.method}`;
}

/** A configured provider, ready to send: its settings plus its decrypted secret. */
export interface MailAccount {
    config: MailConfig;
    /** API key or password, decrypted at the call site and never logged. */
    secret: string;
}
