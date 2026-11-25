/**
 * Migrated history must open on the readers that open sealed messages today,
 * with no change to them: the same content format, binding and signature
 * check (`mls-client.ts openStored`), under the legacy epoch's history key.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("@polaris/db", () => ({ Prisma: { DbNull: null }, prisma: {} }));

import * as content from "@polaris/chat-crypto/message-content";
import { LEGACY_EPOCH, MIGRATION_DEVICE, contentOf, newSigner, sealVersion } from "@/lib/chat/e2ee/legacy-migration";
import { decodeSealedContent } from "@/lib/chat/e2ee/sealed-chat";
import { accountHpkeKeyPair, accountPublicKeys, generateAccountKey } from "@polaris/chat-crypto/account-key";

const CHANNEL = "0192f000-0000-7000-8000-000000000001";
const MESSAGE = "0192f000-0000-7000-8000-0000000000aa";

describe("legacy migration seal", () => {
    it("seals a plain message so a reader verifies its signature and opens it to the same words", async () => {
        const historyKey = content.newHistoryKey();
        const signer = await newSigner();
        const binding = { conversationId: CHANNEL, epoch: LEGACY_EPOCH, messageId: MESSAGE, senderLeaf: 0, revision: 2 };
        const version = contentOf("hola, mundo", { from: "en", to: "es", original: "hello, world" });
        expect(version).toEqual({ body: "hola, mundo", translation: { from: "en", to: "es", original: "hello, world" } });
        const sealed = await sealVersion(historyKey, signer, binding, version!);

        expect(sealed).toMatchObject({ e2eeEpoch: LEGACY_EPOCH, e2eeSenderLeaf: 0, e2eeDevice: MIGRATION_DEVICE, e2eeRevision: 2 });
        expect(await content.verifyMessageSignature(sealed.e2eeSignatureKey, binding, sealed.e2eeCiphertext, sealed.e2eeSignature)).toBe(true);
        const opened = await content.openMessage(historyKey, binding, sealed.e2eeCiphertext);
        expect(decodeSealedContent(opened)).toEqual(version);
    });

    it("binds each version to its revision and message, and revision 0 to none", async () => {
        const historyKey = content.newHistoryKey();
        const signer = await newSigner();
        const first = { conversationId: CHANNEL, epoch: LEGACY_EPOCH, messageId: MESSAGE, senderLeaf: 0, revision: 0 };
        const sealed = await sealVersion(historyKey, signer, first, { body: "antes" });
        expect(sealed.e2eeRevision).toBeNull();
        expect(await content.verifyMessageSignature(sealed.e2eeSignatureKey, { ...first, revision: 1 }, sealed.e2eeCiphertext, sealed.e2eeSignature)).toBe(false);
        await expect(content.openMessage(historyKey, { ...first, messageId: CHANNEL }, sealed.e2eeCiphertext)).rejects.toThrow();
        await expect(content.openMessage(content.newHistoryKey(), first, sealed.e2eeCiphertext)).rejects.toThrow();
    });

    it("seals the history key to an account so its next device opens it", async () => {
        const historyKey = content.newHistoryKey();
        const accountKey = generateAccountKey();
        const pair = await accountHpkeKeyPair(accountKey);
        const account = { hpkePublicKey: (await accountPublicKeys(accountKey)).hpkePublicKey, hpkePrivateKey: pair.privateKey };
        const binding = { recipient: "user-1", conversationId: CHANNEL, epoch: LEGACY_EPOCH };
        const envelope = await content.sealHistoryKey(account.hpkePublicKey, historyKey, binding);
        expect(await content.openHistoryKey(account.hpkePrivateKey, envelope, binding)).toEqual(historyKey);
    });

    it("leaves out a translation that is not one a reader takes, and refuses words a reader could not open", () => {
        expect(contentOf("hola", { nonsense: true })).toEqual({ body: "hola" });
        expect(contentOf("hola", null)).toEqual({ body: "hola" });
        expect(contentOf("x".repeat(1_000_000), null)).toBeNull();
    });
});
