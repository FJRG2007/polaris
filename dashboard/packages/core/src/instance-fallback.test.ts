import { describe, expect, it } from "vitest";
import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import {
    challengeMessage,
    createFailover,
    isCertificateFailure,
    readInstance,
    USING_LOCAL_WORDS,
    type InstanceRecord
} from "./instance-fallback";

const PRIMARY = "https://polaris.example.com";
const LOCAL = "https://polaris.local";
const LAN = "https://192.168.1.20";
const ID = "inst_0123456789abcdef";

function keyPair(): { publicKey: string; privateKey: KeyObject } {
    const pair = generateKeyPairSync("ed25519");
    const jwk = pair.publicKey.export({ format: "jwk" });
    return { publicKey: String(jwk.x), privateKey: pair.privateKey };
}

const real = keyPair();
const impostor = keyPair();

const record: InstanceRecord = { id: ID, publicKey: real.publicKey, addresses: [PRIMARY, LOCAL, LAN] };

interface Seen {
    readonly url: string;
    readonly authorization: string | null;
}

type Behaviour = "up" | "down" | "gateway" | "unauthorized";

/** A network of fake addresses: each one is up, down, or signs with some key. */
function network(setup: Record<string, { behaviour: Behaviour; key?: KeyObject }>) {
    const seen: Seen[] = [];
    const fetchImpl = async (url: string, init: RequestInit = {}): Promise<Response> => {
        const parsed = new URL(url);
        const node = setup[parsed.origin];
        const headers = new Headers(init.headers);
        seen.push({ url, authorization: headers.get("authorization") });
        if (!node || node.behaviour === "down") throw new TypeError("fetch failed");
        if (node.behaviour === "gateway") return new Response("tunnel offline", { status: 530 });
        if (parsed.pathname === "/api/instance/challenge") {
            const { nonce } = JSON.parse(String(init.body)) as { nonce: string };
            const signature = sign(
                null,
                Buffer.from(challengeMessage(ID, parsed.origin, nonce)),
                node.key ?? real.privateKey
            ).toString("base64url");
            return Response.json({ id: ID, nonce, signature });
        }
        if (node.behaviour === "unauthorized") return new Response("no", { status: 401 });
        return Response.json({ from: parsed.origin });
    };
    return { fetchImpl, seen };
}

const TOKEN = "Bearer plr_secret";

describe("readInstance", () => {
    it("keeps a well-formed answer and refuses a malformed key", () => {
        expect(readInstance({ id: ID, publicKey: real.publicKey, addresses: [`${PRIMARY}/`] })).toEqual({
            id: ID,
            publicKey: real.publicKey,
            addresses: [PRIMARY]
        });
        expect(readInstance({ id: ID, publicKey: "short", addresses: [] })).toBeNull();
        expect(readInstance({ id: ID, publicKey: real.publicKey, addresses: ["ftp://x"] })).toBeNull();
    });
});

describe("createFailover", () => {
    it("uses a verified alternate when the primary is down, and says so", async () => {
        const { fetchImpl, seen } = network({ [PRIMARY]: { behaviour: "down" }, [LOCAL]: { behaviour: "up" } });
        const failover = createFailover({ primary: PRIMARY, instance: record, fetch: fetchImpl });
        const response = await failover.request("/api/v1/me", { headers: { authorization: TOKEN } });
        expect(await response.json()).toEqual({ from: LOCAL });
        expect(failover.status()).toMatchObject({ origin: LOCAL, local: true, words: USING_LOCAL_WORDS });
        const challenge = seen.find((one) => one.url === `${LOCAL}/api/instance/challenge`);
        expect(challenge?.authorization).toBeNull();
    });

    it("treats a tunnel's offline answer as the primary being down", async () => {
        const { fetchImpl } = network({ [PRIMARY]: { behaviour: "gateway" }, [LOCAL]: { behaviour: "up" } });
        const failover = createFailover({ primary: PRIMARY, instance: record, fetch: fetchImpl });
        expect(await (await failover.request("/x")).json()).toEqual({ from: LOCAL });
    });

    it("never sends the credential to an alternate that signs with another key", async () => {
        const { fetchImpl, seen } = network({
            [PRIMARY]: { behaviour: "down" },
            [LOCAL]: { behaviour: "up", key: impostor.privateKey },
            [LAN]: { behaviour: "down" }
        });
        const failover = createFailover({ primary: PRIMARY, instance: record, fetch: fetchImpl });
        await expect(failover.request("/api/v1/me", { headers: { authorization: TOKEN } })).rejects.toThrow();
        const toLocal = seen.filter((one) => one.url.startsWith(LOCAL));
        expect(toLocal.map((one) => one.url)).toEqual([`${LOCAL}/api/instance/challenge`]);
        expect(toLocal.every((one) => one.authorization === null)).toBe(true);
        expect(failover.status().refused).toEqual([LOCAL]);
    });

    it("does not fall back on a 401", async () => {
        const { fetchImpl, seen } = network({
            [PRIMARY]: { behaviour: "unauthorized" },
            [LOCAL]: { behaviour: "up" }
        });
        const failover = createFailover({ primary: PRIMARY, instance: record, fetch: fetchImpl });
        const response = await failover.request("/api/v1/me", { headers: { authorization: TOKEN } });
        expect(response.status).toBe(401);
        expect(seen.some((one) => one.url.startsWith(LOCAL))).toBe(false);
        expect(failover.status().local).toBe(false);
    });

    it("goes back to the primary once the hold runs out and it answers again", async () => {
        let clock = 0;
        const setup: Record<string, { behaviour: Behaviour }> = {
            [PRIMARY]: { behaviour: "down" },
            [LOCAL]: { behaviour: "up" }
        };
        const { fetchImpl } = network(setup);
        const failover = createFailover({
            primary: PRIMARY,
            instance: record,
            fetch: fetchImpl,
            now: () => clock,
            holdMs: 1000
        });
        await failover.request("/x");
        expect(failover.status().origin).toBe(LOCAL);
        setup[PRIMARY] = { behaviour: "up" };
        clock = 500;
        expect(await (await failover.request("/x")).json()).toEqual({ from: LOCAL });
        clock = 1500;
        expect(await (await failover.request("/x")).json()).toEqual({ from: PRIMARY });
        expect(failover.status()).toMatchObject({ origin: PRIMARY, local: false, words: null });
    });

    it("calls an alternate untrusted when it answers only without TLS", async () => {
        const { fetchImpl } = network({ [PRIMARY]: { behaviour: "down" } });
        const asked: string[] = [];
        const failover = createFailover({
            primary: PRIMARY,
            instance: record,
            fetch: fetchImpl,
            answersWithoutTls: async (origin) => {
                asked.push(origin);
                return origin === LOCAL;
            }
        });
        await expect(failover.request("/x")).rejects.toThrow();
        expect(asked).toEqual([LOCAL, LAN]);
        expect(failover.status().untrusted).toEqual([LOCAL]);
    });

    it("has no alternates without a learned instance", async () => {
        const { fetchImpl, seen } = network({ [PRIMARY]: { behaviour: "down" }, [LOCAL]: { behaviour: "up" } });
        const failover = createFailover({ primary: PRIMARY, instance: null, fetch: fetchImpl });
        await expect(failover.request("/x")).rejects.toThrow();
        expect(seen.every((one) => one.url.startsWith(PRIMARY))).toBe(true);
    });
});

describe("isCertificateFailure", () => {
    it("finds Node's certificate code on the cause", () => {
        const error = new TypeError("fetch failed", { cause: { code: "SELF_SIGNED_CERT_IN_CHAIN" } });
        expect(isCertificateFailure(error)).toBe(true);
        expect(isCertificateFailure(new TypeError("fetch failed"))).toBe(false);
    });
});
