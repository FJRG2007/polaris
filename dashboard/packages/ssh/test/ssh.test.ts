import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import type { Client } from "ssh2";
import { SshPool } from "../src/pool.js";
import { hostKeyAccepted } from "../src/client.js";

// The security-critical pinning decision, isolated as a pure function. A host's
// known_hosts commonly holds several key types (rsa/ecdsa/ed25519) while the
// client negotiates exactly one, so the pin must be a SET the presented key is
// a member of - the single-key regression these tests guard against.
describe("hostKeyAccepted (host-key pinning)", () => {
    const ED = "AAAAed25519key";
    const RSA = "AAAArsakey";

    it("trusts on add when no pin is provided (undefined)", () => {
        expect(hostKeyAccepted(ED, undefined)).toBe(true);
    });

    it("accepts a matching single pin and refuses a changed key", () => {
        expect(hostKeyAccepted(ED, ED)).toBe(true);
        // A changed host key is refused - this is the SFTP blind-TOFU fix.
        expect(hostKeyAccepted(RSA, ED)).toBe(false);
    });

    it("accepts any member of a pinned set (multi-key known_hosts)", () => {
        expect(hostKeyAccepted(ED, [RSA, ED])).toBe(true);
        expect(hostKeyAccepted(RSA, [RSA, ED])).toBe(true);
    });

    it("refuses a key absent from the pinned set", () => {
        expect(hostKeyAccepted("AAAAother", [ED, RSA])).toBe(false);
    });

    it("refuses an empty pin set (fail-closed)", () => {
        expect(hostKeyAccepted(ED, [])).toBe(false);
    });
});

// A connection whose handshake costs more than the work done over it, so the pool
// is what makes a short operation short. What is worth testing is not the saving
// but the safety: a borrowed connection must not be closed under its borrower.
describe("SshPool", () => {
    /** Stands in for an ssh2 client: emits close/error and records `end`. */
    class FakeClient extends EventEmitter {
        public ended = 0;
        public end(): void {
            this.ended += 1;
            this.emit("close");
        }
    }

    function factory(): { connect: () => Promise<Client>; clients: FakeClient[] } {
        const clients: FakeClient[] = [];
        return {
            clients,
            connect: async () => {
                const client = new FakeClient();
                clients.push(client);
                return client as unknown as Client;
            }
        };
    }

    it("hands the same connection to repeated borrowers", async () => {
        const { connect, clients } = factory();
        const pool = new SshPool();
        const first = await pool.acquire("host-a", connect);
        first.release();
        const second = await pool.acquire("host-a", connect);
        expect(second.client).toBe(first.client);
        expect(clients).toHaveLength(1);
    });

    it("opens one connection for borrowers racing on the same key", async () => {
        const { connect, clients } = factory();
        const pool = new SshPool();
        const leases = await Promise.all([
            pool.acquire("host-a", connect),
            pool.acquire("host-a", connect),
            pool.acquire("host-a", connect)
        ]);
        expect(clients).toHaveLength(1);
        expect(new Set(leases.map((lease) => lease.client)).size).toBe(1);
    });

    it("keeps a separate connection per key", async () => {
        const { connect, clients } = factory();
        const pool = new SshPool();
        await pool.acquire("drive:host-a", connect);
        await pool.acquire("exec:host-a", connect);
        expect(clients).toHaveLength(2);
        expect(pool.size).toBe(2);
    });

    it("never sweeps a connection that is still leased", async () => {
        const { connect, clients } = factory();
        const pool = new SshPool(1_000);
        const lease = await pool.acquire("host-a", connect);
        // Long past the idle TTL, but in use - a download outliving the TTL must
        // not have its connection closed under it.
        pool.sweep(Date.now() + 60_000);
        expect(clients[0]!.ended).toBe(0);
        expect(pool.size).toBe(1);

        lease.release();
        pool.sweep(Date.now() + 60_000);
        expect(clients[0]!.ended).toBe(1);
        expect(pool.size).toBe(0);
    });

    it("reconnects after the connection dies", async () => {
        const { connect, clients } = factory();
        const pool = new SshPool();
        const lease = await pool.acquire("host-a", connect);
        lease.release();
        clients[0]!.emit("close");
        const next = await pool.acquire("host-a", connect);
        expect(clients).toHaveLength(2);
        expect(next.client).not.toBe(lease.client);
    });

    it("evicts on demand, so a rotated credential is not reused", async () => {
        const { connect, clients } = factory();
        const pool = new SshPool();
        (await pool.acquire("host-a", connect)).release();
        pool.evict("host-a");
        expect(clients[0]!.ended).toBe(1);
        await pool.acquire("host-a", connect);
        expect(clients).toHaveLength(2);
    });

    it("does not cache a refused connect", async () => {
        let attempts = 0;
        const pool = new SshPool();
        const connect = async (): Promise<Client> => {
            attempts += 1;
            throw new Error("auth failed");
        };
        await expect(pool.acquire("host-a", connect)).rejects.toThrow("auth failed");
        await expect(pool.acquire("host-a", connect)).rejects.toThrow("auth failed");
        expect(attempts).toBe(2);
        expect(pool.size).toBe(0);
    });
});
