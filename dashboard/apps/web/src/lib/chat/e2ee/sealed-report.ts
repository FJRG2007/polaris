/**
 * A report of a sealed message (docs/chat-e2ee-mls.md, "Sealed reports").
 *
 * The server cannot read a sealed message, and a moderator has to. So the
 * reader who reports it hands over that message's own key and nonce
 * (`messageDisclosure`): it opens this one version of this one message and
 * nothing else, and says nothing about the conversation's history key.
 *
 * What the moderators then read is checked, not taken on the reporter's word:
 * the stored ciphertext must carry its sender device's signature under the key
 * the server held for that device, and the disclosure must open that same
 * ciphertext under its own binding. A reader can neither put words in the
 * sender's mouth nor point a disclosure at another message.
 */

import * as content from "@polaris/chat-crypto/message-content";
import { fromText } from "./base64url";
import { decodeSealedContent, type SealedContent } from "./sealed-chat";

/** The sealed fields of a stored message, as `ChatMessage` holds them. */
export interface SealedReportRow {
    readonly channelId: string;
    readonly clientKey: string | null;
    readonly e2eeCiphertext: Uint8Array | null;
    readonly e2eeEpoch: bigint | null;
    readonly e2eeSenderLeaf: number | null;
    readonly e2eeSignature: Uint8Array | null;
    readonly e2eeSignatureKey: Uint8Array | null;
    readonly e2eeRevision: number | null;
}

/** Whether a stored message is sealed. */
export const isSealedRow = (row: Partial<SealedReportRow>): boolean => Boolean(row.e2eeCiphertext);

/** A disclosure in its text form: unpadded base64url of `DISCLOSURE_BYTES`. */
export const DISCLOSURE_PATTERN = /^[A-Za-z0-9_-]{59}$/;

/**
 * What the reported message says, opened with the reporter's disclosure and
 * checked against the sender's signature. Null for anything that does not
 * check or open: a malformed row, a wrong disclosure, a moved or edited one.
 */
export async function openReported(row: SealedReportRow, disclosure: string): Promise<SealedContent | null> {
    const { clientKey, e2eeCiphertext, e2eeEpoch, e2eeSenderLeaf, e2eeSignature, e2eeSignatureKey } = row;
    if (!clientKey || !e2eeCiphertext || e2eeEpoch === null || e2eeSenderLeaf === null || !e2eeSignature || !e2eeSignatureKey) return null;
    if (!DISCLOSURE_PATTERN.test(disclosure)) return null;
    const binding = { conversationId: row.channelId, epoch: e2eeEpoch, messageId: clientKey, senderLeaf: e2eeSenderLeaf, revision: row.e2eeRevision ?? 0 };
    const sealed = new Uint8Array(e2eeCiphertext);
    try {
        if (!(await content.verifyMessageSignature(new Uint8Array(e2eeSignatureKey), binding, sealed, new Uint8Array(e2eeSignature)))) return null;
        return decodeSealedContent(await content.openDisclosed(fromText(disclosure), binding, sealed));
    } catch {
        return null;
    }
}

/** The words a moderator reads for opened content: the post title, then the text. */
export const reportedText = (opened: SealedContent): string => [opened.title, opened.body].filter(Boolean).join("\n");
