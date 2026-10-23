import { describe, expect, it } from "vitest";
import { generateKeyPairSync, sign } from "node:crypto";
import { PolarisClient, readCredentials } from "../src/polaris";
import { challengeMessage } from "../../../packages/core/src/instance-fallback";

const PRIMARY = "https://polaris.example.com";
const LOCAL = "https://polaris.local";
const ID = "plr_fixture_instance";
const pair = generateKeyPairSync("ed25519");
const instance = { id: ID, publicKey: String(pair.publicKey.export({ format: "jwk" }).x), addresses: [PRIMARY, LOCAL] };

describe("the deck on the local network", () => {
    it("keeps the instance it stored, and reaches it locally only after it proves itself", async () => {
        const credentials = readCredentials({ address: PRIMARY, token: "plr_deck", instance });
        expect(credentials?.instance?.id).toBe(ID);
        const seen: { url: string; authorization: string | null }[] = [];
        const fetcher = (async (url: string, init: RequestInit = {}) => {
            const parsed = new URL(url);
            seen.push({ url, authorization: new Headers(init.headers).get("authorization") });
            if (parsed.origin === PRIMARY) throw new TypeError("fetch failed");
            if (parsed.pathname === "/api/instance/challenge") {
                const { nonce } = JSON.parse(String(init.body)) as { nonce: string };
                const signature = sign(null, Buffer.from(challengeMessage(ID, LOCAL, nonce)), pair.privateKey);
                return Response.json({ id: ID, nonce, signature: signature.toString("base64url") });
            }
            return Response.json({ actions: [], releases: null });
        }) as typeof fetch;
        const client = new PolarisClient("0.0.0-test", fetcher);
        await client.listing(credentials!);
        expect(seen.at(-1)).toEqual({ url: `${LOCAL}/api/deck/actions`, authorization: "Bearer plr_deck" });
        expect(client.addressWords(credentials!)).toBe("Using your local network address");
    });
});
