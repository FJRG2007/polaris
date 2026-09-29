/**
 * Why an alert did not go out, in the reader's words.
 *
 * The senders (`sms-service`, `webhook-sender`) and the dispatcher answer in
 * English: they run inside the notification pass, where there is nobody to ask
 * for a language, and what they answer is stored on the destination and the
 * delivery log. This matches that English back to its key in the `components`
 * catalog when somebody reads it, exactly or by its shape for one that carries
 * a status. Anything else - Twilio's own explanation, a newer sender - passes
 * through.
 */

import type { NamespaceKey, NamespaceTranslator } from "@/lib/i18n/types";

type Words = NamespaceTranslator<"components">;
type Key = NamespaceKey<"components">;

const EXACT: Readonly<Record<string, Key>> = {
    "No working SMS sender is configured.": "delivery.noSmsSender",
    "The SMS sender's settings are no longer valid.": "delivery.smsSettings",
    "The SMS sender has no credential stored.": "delivery.smsNoCredential",
    "The SMS sender's credential cannot be read. Re-enter it.": "delivery.smsCredentialUnreadable",
    "Twilio did not answer in time.": "delivery.twilioTimeout",
    "Twilio could not be reached.": "delivery.twilioUnreachable",
    "Twilio could not be reached to check the credential.": "delivery.twilioCheckUnreachable",
    "Twilio rejected that account SID and auth token.": "delivery.twilioRejected",
    "Give the sender a name.": "delivery.senderName",
    "That sender no longer exists.": "delivery.senderGone",
    "The stored auth token cannot be read. Enter it again.": "delivery.tokenUnreadable",
    "Enter the auth token for this provider.": "delivery.tokenMissing",
    "Could not store the sender.": "delivery.senderNotStored",
    "That is not a Telegram sendMessage URL with a chat_id.": "delivery.telegramUrl",
    "The endpoint could not be reached.": "delivery.endpointUnreachable",
    "The endpoint is gone (404). It was probably deleted.": "delivery.endpointGone",
    "The endpoint refused the message (unauthorized).": "delivery.endpointUnauthorized",
    "The endpoint is rate limiting Polaris (429).": "delivery.endpointRateLimited",
    "The destination is switched off, deleted, or its target cannot be read.": "delivery.destinationOff",
    "No confirmed address on the account.": "delivery.noAddress",
    "Marked read: you had the page it points at open.": "delivery.markedRead",
    "Turned off for this event.": "delivery.eventOff"
};

const SHAPED: readonly (readonly [RegExp, Key])[] = [
    [/^Twilio refused the message \(HTTP (\d+)\)\.$/, "delivery.twilioRefused"],
    [/^Twilio answered HTTP (\d+)\.$/, "delivery.twilioAnswered"],
    [/^The endpoint answered HTTP (\d+)\.$/, "delivery.endpointAnswered"]
];

/** Every English sentence this knows, for the test that holds the catalog to it. */
export const KNOWN_DELIVERY_SENTENCES: readonly string[] = Object.keys(EXACT);

export function deliveryText(t: Words, message: string): string {
    const exact = EXACT[message];
    if (exact) return t(exact);
    for (const [pattern, key] of SHAPED) {
        const match = pattern.exec(message);
        if (match) return t(key, { status: Number(match[1]) });
    }
    return message;
}
