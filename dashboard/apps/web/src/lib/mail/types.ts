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
}

/** A configured provider, ready to send: its settings plus its decrypted secret. */
export interface MailAccount {
    config: MailConfig;
    /** API key or password, decrypted at the call site and never logged. */
    secret: string;
}
