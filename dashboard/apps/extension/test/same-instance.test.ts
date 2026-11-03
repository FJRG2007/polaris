/**
 * The same Polaris typed under another name is found by its signature, over the
 * address itself or, when the browser cannot open it, the same host without TLS.
 */

import { describe, expect, it } from "vitest";
import { createSameInstanceCheck } from "../src/lib/same-instance";
import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { challengeMessage, type InstanceRecord } from "@polaris/core/instance-fallback";

const HOME = "https://polaris.example.com";
const LOCAL = "https://polaris.local";
const LOCAL_PLAIN = "http://polaris.local";
const ID = "inst_0123456789abcdef";

function keyPair(): { publicKey: string; privateKey: KeyObject } {
    const pair = generateKeyPairSync("ed25519");
    return {
        publicKey: String(pair.publicKey.export({ format: "jwk" }).x),
        privateKey: pair.privateKey
    };
}

const real = keyPair();
const impostor = keyPair();
const record: InstanceRecord = { id: ID, publicKey: real.publicKey, addresses: [HOME] };

/** `up` answers as the instance signing with `key`; anything else fails like a bad certificate. */
function network(up: readonly string[], key: KeyObject = real.privateKey) {
    const seen: {
        url: string;
        cookies: RequestCredentials | undefined;
        authorization: string | null;
    }[] = [];
    const fetchImpl = async (url: string, init: RequestInit = {}): Promise<Response> => {
        const parsed = new URL(url);
        seen.push({
            url,
            cookies: init.credentials,
            authorization: new Headers(init.headers).get("authorization")
        });
        if (!up.includes(parsed.origin)) throw new TypeError("Failed to fetch");
        if (parsed.pathname === "/api/instance") return Response.json(record);
        const { nonce } = JSON.parse(String(init.body)) as { nonce: string };
        const signer = parsed.origin === HOME ? real.privateKey : key;
        const signature = sign(
            null,
            Buffer.from(challengeMessage(ID, parsed.origin, nonce)),
            signer
        ).toString("base64url");
        return Response.json({ id: ID, nonce, signature });
    };
    return { fetchImpl, seen };
}

describe("createSameInstanceCheck", () => {
    it("names the listed server a trusted local address proves it is", async () => {
        const { fetchImpl, seen } = network([HOME, LOCAL]);
        expect(await createSameInstanceCheck(fetchImpl)(LOCAL, [HOME])).toBe(HOME);
        expect(seen.every((one) => one.cookies === "omit" && one.authorization === null)).toBe(
            true
        );
    });

    it("asks the host without TLS when its certificate is not trusted", async () => {
        const { fetchImpl } = network([HOME, LOCAL_PLAIN]);
        expect(await createSameInstanceCheck(fetchImpl)(LOCAL, [HOME])).toBe(HOME);
    });

    it("finds nothing when the address cannot sign with the listed key", async () => {
        const { fetchImpl } = network([HOME, LOCAL], impostor.privateKey);
        expect(await createSameInstanceCheck(fetchImpl)(LOCAL, [HOME])).toBeNull();
    });

    it("finds nothing when the address cannot be asked at all", async () => {
        const { fetchImpl } = network([HOME]);
        expect(await createSameInstanceCheck(fetchImpl)(LOCAL, [HOME])).toBeNull();
    });

    it("asks again only once the answer is old", async () => {
        let now = 0;
        const { fetchImpl, seen } = network([HOME, LOCAL]);
        const check = createSameInstanceCheck(fetchImpl, () => now);
        await check(LOCAL, [HOME]);
        const asked = seen.length;
        await check(LOCAL, [HOME]);
        expect(seen.length).toBe(asked);
        now = 60_000;
        await check(LOCAL, [HOME]);
        expect(seen.length).toBeGreaterThan(asked);
    });
});
