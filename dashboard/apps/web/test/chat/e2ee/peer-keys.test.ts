import { afterEach, describe, expect, it, vi } from "vitest";
import { FakeKeyLog } from "./support/fake-key-log";
import * as peerKeys from "@/lib/chat/e2ee/peer-keys";
import * as keyLog from "@/lib/chat/e2ee/key-log-client";

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

        it("takes nobody's first sight on the server's word when the key log cannot be asked", async () => {
            stubStorage();
            const KNOWN = "0190a1b2-0000-7000-8000-000000000001";
            const NEW = "0190a1b2-0000-7000-8000-000000000002";
            const pair = (n: number) => ({ signPublicKey: Buffer.alloc(32, n).toString("base64url"), hpkePublicKey: Buffer.alloc(32, n + 1).toString("base64url") });
            vi.stubGlobal("fetch", async (url: string) =>
                String(url).includes("/api/e2ee/key-log")
                    ? new Response("{}", { status: 503 })
                    : Response.json({ accountKeys: [{ userId: KNOWN, ...pair(1) }, { userId: NEW, ...pair(3) }] })
            );
            peerKeys.updateBook("me", (book) => peerKeys.observePeer(book, KNOWN, A, 1));
            const recorded = await peerKeys.checkPeers("me", "0190a1b2-0000-7000-8000-0000000000cc", [KNOWN, NEW]);
            expect([...recorded.keys()]).toEqual([KNOWN]);
            // The known peer's served key differs from the remembered one: the change still shows.
            expect(peerKeys.readBook("me")[KNOWN]?.changed).toBe(true);
            expect(peerKeys.readBook("me")[NEW]).toBeUndefined();
        });

        describe("a key that rotated between the two asks", () => {
            const PEER = "0190a1b2-0000-7000-8000-0000000000a1";
            const CHANNEL = "0190a1b2-0000-7000-8000-0000000000cc";
            const bytes = (n: number) => new Uint8Array(32).fill(n);
            let own = 0;

            /** A log holding PEER at version 2, and the stale version 1 key the server handed out before it rotated. */
            async function rotatedPeer() {
                stubStorage();
                const fake = await FakeKeyLog.create();
                await fake.append({ userId: PEER, akVersion: 1, signPublicKey: bytes(1), hpkePublicKey: bytes(2) });
                await fake.append({ userId: PEER, akVersion: 2, signPublicKey: bytes(3), hpkePublicKey: bytes(4) });
                const ownId = `me-${++own}`;
                vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => Response.json(await fake.answer(ownId, JSON.parse(init.body as string))));
                return { ownId, stale: [{ userId: PEER, signPublicKey: bytes(1), hpkePublicKey: bytes(2) }] };
            }

            it("reports nothing when the key served afresh is the one the log holds, and vouches for neither", async () => {
                const { ownId, stale } = await rotatedPeer();
                const vouched = await keyLog.vouchedAccounts(ownId, CHANNEL, stale, async () => [{ userId: PEER, signPublicKey: bytes(3), hpkePublicKey: bytes(4) }]);
                expect([...vouched!]).toEqual([]);
                expect(keyLog.logProblem(ownId)).toBeNull();
            });

            it("reports a key served afresh that the log still contradicts", async () => {
                const { ownId, stale } = await rotatedPeer();
                await keyLog.vouchedAccounts(ownId, CHANNEL, stale, async () => [{ userId: PEER, signPublicKey: bytes(5), hpkePublicKey: bytes(6) }]);
                expect(keyLog.logProblem(ownId)).toBe("inclusion");
            });

            it("reports nothing for a key no longer served, or a refetch that did not arrive", async () => {
                const gone = await rotatedPeer();
                await keyLog.vouchedAccounts(gone.ownId, CHANNEL, gone.stale, async () => []);
                expect(keyLog.logProblem(gone.ownId)).toBeNull();
                const lost = await rotatedPeer();
                await keyLog.vouchedAccounts(lost.ownId, CHANNEL, lost.stale, async () => null);
                expect(keyLog.logProblem(lost.ownId)).toBeNull();
            });

            it("reports the mismatch at once when there is no way to ask again", async () => {
                const { ownId, stale } = await rotatedPeer();
                await keyLog.vouchedAccounts(ownId, CHANNEL, stale);
                expect(keyLog.logProblem(ownId)).toBe("inclusion");
            });
        });

        describe("recovery custodians", () => {
            const CUSTODIAN = "0190a1b2-0000-7000-8000-0000000000b1";
            const OTHER = "0190a1b2-0000-7000-8000-0000000000b2";
            const bytes = (n: number) => new Uint8Array(32).fill(n);
            let own = 0;

            async function logWith(...entries: Array<{ userId: string; akVersion: number; hpke: number }>) {
                stubStorage();
                const fake = await FakeKeyLog.create();
                for (const e of entries) await fake.append({ userId: e.userId, akVersion: e.akVersion, signPublicKey: bytes(9), hpkePublicKey: bytes(e.hpke) });
                const ownId = `custodian-check-${++own}`;
                const bodies: unknown[] = [];
                vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
                    const body = JSON.parse(init.body as string);
                    bodies.push(body);
                    return Response.json(await fake.answer(ownId, body));
                });
                return { ownId, bodies };
            }

            it("vouches only when every custodian's key is the logged one at that version, asking in the recovery scope", async () => {
                const { ownId, bodies } = await logWith({ userId: CUSTODIAN, akVersion: 1, hpke: 2 }, { userId: OTHER, akVersion: 3, hpke: 4 });
                expect(await keyLog.vouchedCustodians(ownId, [{ userId: CUSTODIAN, akVersion: 1, hpkePublicKey: bytes(2) }, { userId: OTHER, akVersion: 3, hpkePublicKey: bytes(4) }])).toBe(true);
                expect(bodies[0]).toMatchObject({ op: "proofs", recovery: true, userIds: [CUSTODIAN, OTHER] });
            });

            it("fails closed on a substituted key, a missing account, another version or no answer", async () => {
                const substituted = await logWith({ userId: CUSTODIAN, akVersion: 1, hpke: 2 });
                expect(await keyLog.vouchedCustodians(substituted.ownId, [{ userId: CUSTODIAN, akVersion: 1, hpkePublicKey: bytes(7) }])).toBe(false);
                expect(keyLog.logProblem(substituted.ownId)).toBe("inclusion");

                const missing = await logWith({ userId: CUSTODIAN, akVersion: 1, hpke: 2 });
                expect(await keyLog.vouchedCustodians(missing.ownId, [{ userId: CUSTODIAN, akVersion: 1, hpkePublicKey: bytes(2) }, { userId: OTHER, akVersion: 1, hpkePublicKey: bytes(2) }])).toBe(false);

                const rotated = await logWith({ userId: CUSTODIAN, akVersion: 2, hpke: 5 });
                expect(await keyLog.vouchedCustodians(rotated.ownId, [{ userId: CUSTODIAN, akVersion: 1, hpkePublicKey: bytes(2) }])).toBe(false);
                expect(keyLog.logProblem(rotated.ownId)).toBeNull();

                stubStorage();
                vi.stubGlobal("fetch", async () => new Response("{}", { status: 503 }));
                expect(await keyLog.vouchedCustodians("custodian-check-down", [{ userId: CUSTODIAN, akVersion: 1, hpkePublicKey: bytes(2) }])).toBe(false);
                expect(await keyLog.vouchedCustodians("custodian-check-down", [])).toBe(false);
            });
        });

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
