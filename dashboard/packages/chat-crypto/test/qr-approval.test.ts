/**
 * The account key carried through the QR sign-in. What a malicious server can
 * do here is relay: swap the new device's public key, replay an approval from
 * another flow, move it to another device, flip bytes, or seal a key of its own
 * to the public key it relayed. Every one of those must end in no key at all.
 */

import * as qr from "../src/qr-approval";
import { describe, expect, it } from "vitest";
import * as account from "../src/account-key";

const USER = "0190a1b2-0000-7000-8000-000000000001";
const FLOW = "ABCD2345";
const APPROVER = "0190a1b2-0000-7000-8000-00000000aaaa";
const AK = new Uint8Array(32).map((_, index) => index + 1);

/** A verifier that knows the account's real published keys. */
async function publishedVerifier(accountKey: Uint8Array = AK): Promise<account.AccountKeyVerifier & { calls: number }> {
    const published = await account.accountPublicKeys(accountKey);
    return {
        calls: 0,
        async verify(userId, akVersion, keys) {
            this.calls++;
            return userId === USER && akVersion === 1 && account.samePublicKeys(published, keys);
        }
    };
}

async function flow(flowId = FLOW) {
    const offer = await qr.createQrOffer();
    const fragment = await qr.offerFragment(flowId, offer);
    const scanned = qr.readOfferFragment(fragment)!;
    return { offer, fragment, scanned };
}

async function approve(
    offer: qr.QrOffer,
    scanned: { commitment: Uint8Array; newDeviceId: string },
    overrides: Partial<{ accountKey: Uint8Array; flowId: string; approverDeviceId: string; akVersion: number }> = {}
): Promise<qr.QrApproval> {
    return qr.sealQrApproval({
        accountKey: overrides.accountKey ?? AK,
        akVersion: overrides.akVersion ?? 1,
        userId: USER,
        flowId: overrides.flowId ?? FLOW,
        approverDeviceId: overrides.approverDeviceId ?? APPROVER,
        offerPublicKey: offer.publicKey,
        scanned
    });
}

async function opens(
    offer: qr.QrOffer,
    approval: qr.QrApproval,
    overrides: Partial<{ flowId: string; userId: string; verifier: account.AccountKeyVerifier }> = {}
): Promise<Uint8Array> {
    const opened = await qr.openQrApproval({
        offer,
        flowId: overrides.flowId ?? FLOW,
        userId: overrides.userId ?? USER,
        approval,
        verifier: overrides.verifier ?? (await publishedVerifier())
    });
    return opened.accountKey;
}

describe("QR approval carries the account key", () => {
    it("round-trips: the new device ends up with exactly AK, after the verifier said yes", async () => {
        const { offer, scanned } = await flow();
        const verifier = await publishedVerifier();
        const approval = await approve(offer, scanned);
        expect(Array.from(await opens(offer, approval, { verifier }))).toEqual(Array.from(AK));
        expect(verifier.calls).toBe(1);
    });

    it("survives the trip as text", async () => {
        const { offer, scanned } = await flow();
        const wire = JSON.parse(JSON.stringify(qr.encodeQrApproval(await approve(offer, scanned))));
        expect(Array.from(await opens(offer, qr.decodeQrApproval(wire)))).toEqual(Array.from(AK));
    });

    it("draws a new ephemeral key and device id for every flow", async () => {
        const a = await flow();
        const b = await flow();
        expect(a.offer.newDeviceId).not.toBe(b.offer.newDeviceId);
        expect(Array.from(a.offer.publicKey)).not.toEqual(Array.from(b.offer.publicKey));
        expect(a.offer.publicKey.length).toBe(qr.QR_OFFER_PUBLIC_KEY_BYTES);
    });
});

describe("the commitment in the QR (server swaps the relayed public key)", () => {
    it("refuses to seal to a public key the QR did not commit to", async () => {
        const { scanned } = await flow();
        const impostor = await qr.createQrOffer();
        await expect(approve(impostor, scanned)).rejects.toBeInstanceOf(qr.QrApprovalError);
    });

    it("refuses a commitment made for another flow id", async () => {
        const { offer, scanned } = await flow("OTHER234");
        await expect(approve(offer, scanned)).rejects.toBeInstanceOf(qr.QrApprovalError);
    });

    it("refuses a commitment with any byte flipped", async () => {
        const { offer, scanned } = await flow();
        for (let index = 0; index < scanned.commitment.length; index++) {
            const commitment = scanned.commitment.slice();
            commitment[index]! ^= 0x01;
            await expect(approve(offer, { ...scanned, commitment })).rejects.toBeInstanceOf(qr.QrApprovalError);
        }
    });

    it("reads only the exact fragment shape", () => {
        expect(qr.readOfferFragment("")).toBeNull();
        expect(qr.readOfferFragment("#k=short.id")).toBeNull();
        expect(qr.readOfferFragment(`#k=${"A".repeat(43)}.${"B".repeat(22)}&x=1`)).toBeNull();
        expect(qr.readOfferFragment(`#k=${"A".repeat(44)}.${"B".repeat(22)}`)).toBeNull();
        expect(qr.readOfferFragment(`#k=${"A".repeat(43)}.${"B".repeat(22)}`)).not.toBeNull();
    });
});

describe("tamper of every byte", () => {
    it("fails closed for every flipped byte of the envelope", async () => {
        const { offer, scanned } = await flow();
        const approval = await approve(offer, scanned);
        for (let index = 0; index < approval.envelope.length; index++) {
            const envelope = approval.envelope.slice();
            envelope[index]! ^= 0x80;
            await expect(opens(offer, { ...approval, envelope }), `byte ${index}`).rejects.toBeInstanceOf(
                qr.QrApprovalError
            );
        }
    }, 120_000);

    it("fails closed for every flipped byte of the signature", async () => {
        const { offer, scanned } = await flow();
        const approval = await approve(offer, scanned);
        for (let index = 0; index < approval.signature.length; index++) {
            const signature = approval.signature.slice();
            signature[index]! ^= 0x01;
            await expect(opens(offer, { ...approval, signature })).rejects.toBeInstanceOf(qr.QrApprovalError);
        }
    });

    it("fails closed for a truncated or extended envelope or signature", async () => {
        const { offer, scanned } = await flow();
        const approval = await approve(offer, scanned);
        for (const changed of [
            { ...approval, envelope: approval.envelope.subarray(0, approval.envelope.length - 1) },
            { ...approval, envelope: new Uint8Array([...approval.envelope, 0]) },
            { ...approval, signature: approval.signature.subarray(0, 63) },
            { ...approval, signature: new Uint8Array([...approval.signature, 0]) }
        ])
            await expect(opens(offer, changed)).rejects.toBeInstanceOf(qr.QrApprovalError);
    });
});

describe("swapped bindings", () => {
    it("refuses an approval opened under another flow id", async () => {
        const { offer, scanned } = await flow();
        const approval = await approve(offer, scanned);
        await expect(opens(offer, approval, { flowId: "WXYZ6789" })).rejects.toBeInstanceOf(qr.QrApprovalError);
    });

    it("refuses an approval whose approver device id was swapped in transit", async () => {
        const { offer, scanned } = await flow();
        const approval = await approve(offer, scanned);
        await expect(
            opens(offer, { ...approval, approverDeviceId: "0190a1b2-0000-7000-8000-00000000bbbb" })
        ).rejects.toBeInstanceOf(qr.QrApprovalError);
    });

    it("refuses an approval presented as another account's", async () => {
        const { offer, scanned } = await flow();
        const approval = await approve(offer, scanned);
        const allowAny: account.AccountKeyVerifier = { verify: async () => true };
        await expect(
            opens(offer, approval, { userId: "0190a1b2-0000-7000-8000-000000000002", verifier: allowAny })
        ).rejects.toBeInstanceOf(qr.QrApprovalError);
    });

    it("refuses a key version that differs from the one sealed inside", async () => {
        const { offer, scanned } = await flow();
        const approval = await approve(offer, scanned);
        await expect(opens(offer, { ...approval, akVersion: 2 })).rejects.toBeInstanceOf(qr.QrApprovalError);
    });
});

describe("replay and wrong device", () => {
    it("refuses an approval replayed into a later flow", async () => {
        const first = await flow();
        const approval = await approve(first.offer, first.scanned);
        const second = await flow();
        await expect(opens(second.offer, approval)).rejects.toBeInstanceOf(qr.QrApprovalError);
    });

    it("refuses an approval opened by a device it was not sealed for", async () => {
        const mine = await flow();
        const approval = await approve(mine.offer, mine.scanned);
        const stranger = await qr.createQrOffer();
        // Same id, another key: the device id alone proves nothing.
        await expect(
            opens({ ...stranger, newDeviceId: mine.offer.newDeviceId }, approval)
        ).rejects.toBeInstanceOf(qr.QrApprovalError);
        // Same key, another id.
        await expect(
            opens({ ...mine.offer, newDeviceId: stranger.newDeviceId }, approval)
        ).rejects.toBeInstanceOf(qr.QrApprovalError);
    });
});

describe("11.1 item 17: key-compromise impersonation", () => {
    it("refuses a server-made key sealed to the relayed public key and signed by itself", async () => {
        const { offer, scanned } = await flow();
        // The server knows the ephemeral public key it relayed, so it can run
        // the approving side itself with an account key of its own.
        const forged = new Uint8Array(32).fill(0xee);
        const approval = await approve(offer, scanned, { accountKey: forged });
        await expect(opens(offer, approval)).rejects.toBeInstanceOf(qr.QrApprovalError);
    });

    it("refuses an envelope of the real key signed by another key", async () => {
        const { offer, scanned } = await flow();
        const real = await approve(offer, scanned);
        const other = await approve(offer, scanned, { accountKey: new Uint8Array(32).fill(7) });
        await expect(opens(offer, { ...real, signature: other.signature })).rejects.toBeInstanceOf(
            qr.QrApprovalError
        );
    });

    it("never skips the verifier: a no, a throw or a non-true answer all refuse", async () => {
        const { offer, scanned } = await flow();
        const approval = await approve(offer, scanned);
        const answers: account.AccountKeyVerifier[] = [
            { verify: async () => false },
            {
                verify: async () => {
                    throw new Error("log unreachable");
                }
            },
            { verify: async () => "yes" as unknown as boolean },
            { verify: async () => undefined as unknown as boolean }
        ];
        for (const verifier of answers)
            await expect(opens(offer, approval, { verifier })).rejects.toBeInstanceOf(qr.QrApprovalError);
    });
});
