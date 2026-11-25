/**
 * A stored sealed message as the server holds it, made with the real content
 * layer and a real Ed25519 device key, plus the reader's disclosure of it.
 */

import { toText } from "@/lib/chat/e2ee/base64url";
import * as content from "@polaris/chat-crypto/message-content";
import { encodeSealedContent, type SealedContent } from "@/lib/chat/e2ee/sealed-chat";

const SIGNATURE_LABEL = new TextEncoder().encode("polaris/chat-e2ee/content-signature/v1\u0000");

export async function sealedRow(channelId: string, said: SealedContent, options: { revision?: number } = {}) {
    const historyKey = crypto.getRandomValues(new Uint8Array(32));
    const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
    const publicKey = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
    const clientKey = crypto.randomUUID();
    const binding = { conversationId: channelId, epoch: 4n, messageId: clientKey, senderLeaf: 2, revision: options.revision ?? 0 };
    const ciphertext = await content.sealMessage(historyKey, binding, encodeSealedContent(said));
    const payload = await content.messageSignaturePayload(binding, ciphertext);
    const signed = new Uint8Array(SIGNATURE_LABEL.length + payload.length);
    signed.set(SIGNATURE_LABEL);
    signed.set(payload, SIGNATURE_LABEL.length);
    const signature = new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, pair.privateKey, signed));
    const row = {
        channelId,
        clientKey,
        e2eeCiphertext: ciphertext,
        e2eeEpoch: 4n,
        e2eeSenderLeaf: 2,
        e2eeSignature: signature,
        e2eeSignatureKey: publicKey,
        e2eeRevision: options.revision ? options.revision : null
    };
    const disclose = async (other = binding) => toText(await content.messageDisclosure(historyKey, other));
    return { row, binding, disclosure: await disclose(), disclose };
}
