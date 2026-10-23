import { describe, expect, it, vi } from "vitest";
import { generateKeyPairSync, sign } from "node:crypto";
import { send } from "../src/api.js";
import { challengeMessage } from "../../core/src/instance-fallback.js";

const PRIMARY = "https://polaris.example.com";
const LOCAL = "https://polaris.local";
const ID = "plr_fixture_instance";

const pair = generateKeyPairSync("ed25519");
const instance = { id: ID, publicKey: String(pair.publicKey.export({ format: "jwk" }).x), addresses: [PRIMARY, LOCAL] };

describe("send over the local address", () => {
    it("reaches the same Polaris on its local address when the primary is down, token included", async () => {
        vi.spyOn(process.stderr, "write").mockImplementation(() => true);
        const seen: { url: string; authorization: string | null }[] = [];
        const fetchImpl = (async (url: string, init: RequestInit = {}) => {
            const parsed = new URL(url);
            seen.push({ url, authorization: new Headers(init.headers).get("authorization") });
            if (parsed.origin === PRIMARY) throw new TypeError("fetch failed");
            if (parsed.pathname === "/api/instance/challenge") {
                const { nonce } = JSON.parse(String(init.body)) as { nonce: string };
                const signature = sign(null, Buffer.from(challengeMessage(ID, LOCAL, nonce)), pair.privateKey);
                return Response.json({ id: ID, nonce, signature: signature.toString("base64url") });
            }
            return Response.json({ ok: true });
        }) as typeof fetch;
        const response = await send({ url: PRIMARY, token: "plr_token", instance }, "GET", "/api/v1/me", {
            fetch: fetchImpl
        });
        expect(response.status).toBe(200);
        expect(seen.at(-1)).toEqual({ url: `${LOCAL}/api/v1/me`, authorization: "Bearer plr_token" });
        expect(seen.find((one) => one.url.endsWith("/challenge"))?.authorization).toBeNull();
        expect(process.stderr.write).toHaveBeenCalledWith(expect.stringContaining("Using your local network address"));
    });

    it("never sends a token anywhere but the primary without a learned instance", async () => {
        const fetchImpl = vi.fn(async () => {
            throw new TypeError("fetch failed");
        }) as unknown as typeof fetch;
        await expect(send({ url: PRIMARY, token: "plr_token" }, "GET", "/x", { fetch: fetchImpl })).rejects.toThrow(
            /Could not reach/
        );
        expect(fetchImpl).toHaveBeenCalledTimes(1);
    });
});
