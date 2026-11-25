import { afterEach, describe, expect, it, vi } from "vitest";
import * as peerKeys from "@/lib/chat/e2ee/peer-keys";

const A = "a".repeat(64);
const B = "b".repeat(64);
const DIGITS = "1".repeat(60);

describe("peer key memory", () => {
    it("remembers the first key silently and flags a different one", () => {
        const first = peerKeys.observePeer({}, "peer", A, 1);
        expect(first.peer).toEqual({ fp: A, seenAt: 1, changed: false, verifiedDigits: null });
        expect(peerKeys.observePeer(first, "peer", A, 2).peer).toEqual({ fp: A, seenAt: 2, changed: false, verifiedDigits: null });
        expect(peerKeys.observePeer(first, "peer", B, 3).peer).toEqual({ fp: B, seenAt: 3, changed: true, verifiedDigits: null });
    });

    it("takes a verification away when the key changes, and keeps it when it does not", () => {
        const verified = peerKeys.verifyPeer(peerKeys.observePeer({}, "peer", A, 1), "peer", A, DIGITS);
        expect(verified.peer?.verifiedDigits).toBe(DIGITS);
        expect(peerKeys.observePeer(verified, "peer", A, 2).peer?.verifiedDigits).toBe(DIGITS);
        expect(peerKeys.observePeer(verified, "peer", B, 2).peer?.verifiedDigits).toBeNull();
    });

    it("never lands a verification made against a key that is no longer the one remembered", () => {
        const changed = peerKeys.observePeer(peerKeys.observePeer({}, "peer", A, 1), "peer", B, 2);
        expect(peerKeys.verifyPeer(changed, "peer", A, DIGITS)).toBe(changed);
        expect(peerKeys.verifyPeer({}, "nobody", A, DIGITS)).toEqual({});
    });

    it("settles a change by verifying or acknowledging it", () => {
        const changed = peerKeys.observePeer(peerKeys.observePeer({}, "peer", A, 1), "peer", B, 2);
        expect(peerKeys.acknowledgePeer(changed, "peer").peer?.changed).toBe(false);
        expect(peerKeys.verifyPeer(changed, "peer", B, DIGITS).peer).toMatchObject({ changed: false, verifiedDigits: DIGITS });
        const settled = peerKeys.acknowledgePeer(changed, "peer");
        expect(peerKeys.acknowledgePeer(settled, "peer")).toBe(settled);
    });

    it("keeps at most MAX_PEERS, dropping the least recently seen", () => {
        let book: peerKeys.PeerKeyBook = {};
        for (let i = 0; i <= peerKeys.MAX_PEERS; i++) book = peerKeys.observePeer(book, `p${i}`, A, i);
        expect(Object.keys(book)).toHaveLength(peerKeys.MAX_PEERS);
        expect(book.p0).toBeUndefined();
        expect(book[`p${peerKeys.MAX_PEERS}`]).toBeDefined();
    });

    it("fingerprints both halves of the key", async () => {
        const fp = await peerKeys.keyFingerprint("sign", "hpke");
        expect(fp).toMatch(/^[0-9a-f]{64}$/);
        expect(await peerKeys.keyFingerprint("sign", "hpke")).toBe(fp);
        expect(await peerKeys.keyFingerprint("sign", "other")).not.toBe(fp);
        expect(await peerKeys.keyFingerprint("other", "hpke")).not.toBe(fp);
    });

    describe("in this browser", () => {
        afterEach(() => vi.unstubAllGlobals());
        const stubStorage = (initial: Record<string, string> = {}) => {
            const store = new Map(Object.entries(initial));
            vi.stubGlobal("window", {
                localStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) },
                addEventListener: () => undefined,
                removeEventListener: () => undefined
            });
            return store;
        };

        it("stores per account and tells subscribers", () => {
            stubStorage();
            let calls = 0;
            const stop = peerKeys.subscribeBooks(() => calls++);
            peerKeys.updateBook("me", (book) => peerKeys.observePeer(book, "peer", A, 1));
            expect(peerKeys.readBook("me").peer?.fp).toBe(A);
            expect(peerKeys.readBook("someone-else")).toEqual({});
            expect(calls).toBe(1);
            stop();
        });

        it("drops what it cannot trust and survives storage that throws", () => {
            stubStorage({
                "polaris:chat:peer-keys:me": JSON.stringify({ ok: { fp: A, seenAt: 1, changed: true, verifiedDigits: "12" }, bad: { fp: "x" } })
            });
            expect(peerKeys.readBook("me")).toEqual({ ok: { fp: A, seenAt: 1, changed: true, verifiedDigits: null } });
            vi.stubGlobal("window", { localStorage: { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } } });
            expect(peerKeys.readBook("me")).toEqual({});
            expect(() => peerKeys.updateBook("me", (book) => peerKeys.observePeer(book, "peer", A, 1))).not.toThrow();
        });
    });
});
