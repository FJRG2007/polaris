import { describe, expect, it, vi } from "vitest";
import { generateKeyPairSync, sign } from "node:crypto";
import { send } from "../../src/api.js";
import { loadConfig, saveConfig } from "../../src/config.js";
import { requireSession } from "../../src/context.js";
import { challengeMessage, RELEARN_MS } from "../../../core/src/instance-fallback.js";
import { testContext } from "../helpers/context.js";

const PRIMARY = "https://polaris.example.com";
const LOCAL = "https://polaris.local";
const ID = "plr_fixture_instance";

const pair = generateKeyPairSync("ed25519");
const instance = {
    id: ID,
    publicKey: String(pair.publicKey.export({ format: "jwk" }).x),
    addresses: [PRIMARY, LOCAL]
};

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
                const signature = sign(
                    null,
                    Buffer.from(challengeMessage(ID, LOCAL, nonce)),
                    pair.privateKey
                );
                return Response.json({ id: ID, nonce, signature: signature.toString("base64url") });
            }
            return Response.json({ ok: true });
        }) as typeof fetch;
        const response = await send(
            { url: PRIMARY, token: "plr_token", instance },
            "GET",
            "/api/v1/me",
            {
                fetch: fetchImpl
            }
        );
        expect(response.status).toBe(200);
        expect(seen.at(-1)).toEqual({
            url: `${LOCAL}/api/v1/me`,
            authorization: "Bearer plr_token"
        });
        expect(seen.find((one) => one.url.endsWith("/challenge"))?.authorization).toBeNull();
        expect(process.stderr.write).toHaveBeenCalledWith(
            expect.stringContaining("Using your local network address")
        );
    });

    it("never sends a token anywhere but the primary without a learned instance", async () => {
        const fetchImpl = vi.fn(async () => {
            throw new TypeError("fetch failed");
        }) as unknown as typeof fetch;
        await expect(
            send({ url: PRIMARY, token: "plr_token" }, "GET", "/x", { fetch: fetchImpl })
        ).rejects.toThrow(/Could not reach/);
        expect(fetchImpl).toHaveBeenCalledTimes(1);
    });

    it("still bounds a body that stalls after the headers arrived", async () => {
        const fetchImpl = (async (_url: string, init: RequestInit = {}) => {
            const stream = new ReadableStream({
                start(controller) {
                    init.signal?.addEventListener("abort", () =>
                        controller.error(init.signal?.reason)
                    );
                }
            });
            return new Response(stream, { status: 200 });
        }) as typeof fetch;
        const slow = "https://slow.example.com";
        const response = await send(
            { url: slow, token: "plr_token", instance: { ...instance, addresses: [slow] } },
            "GET",
            "/api/v1/slow",
            {
                fetch: fetchImpl,
                timeoutMs: 50
            }
        );
        await expect(response.text()).rejects.toMatchObject({ name: "TimeoutError" });
    });
});

describe("what a profile knows of its Polaris", () => {
    const profile = {
        url: PRIMARY,
        account: { id: "u1", name: "Ada", email: "ada@example.com" },
        keyId: "k1",
        scopes: [],
        storage: "file" as const,
        signedInAt: new Date(Date.now() - 2 * RELEARN_MS).toISOString(),
        instance: { ...instance, addresses: [PRIMARY] }
    };

    async function signedIn(fetchImpl: typeof fetch) {
        const recorded = await testContext({ fetch: fetchImpl });
        const storage = await recorded.context.secrets.save("home", "plr_fixture_token_0001");
        await saveConfig(recorded.context.configDir, {
            current: "home",
            profiles: { home: { ...profile, storage } }
        });
        return recorded;
    }

    it("is asked again over the usual address once a day, and kept", async () => {
        let asked = 0;
        const fetchImpl = (async (url: string) => {
            if (new URL(url).pathname === "/api/instance") asked += 1;
            return Response.json(instance);
        }) as typeof fetch;
        const { context } = await signedIn(fetchImpl);
        const session = await requireSession(context, {} as never);
        expect(session.connection.instance).toEqual(instance);
        expect((await loadConfig(context.configDir)).profiles["home"]?.instance).toEqual(instance);
        await requireSession(context, {} as never);
        expect(asked).toBe(1);
    });

    it("keeps what it knew when the usual address does not answer", async () => {
        const fetchImpl = (async () => {
            throw new TypeError("fetch failed");
        }) as typeof fetch;
        const { context } = await signedIn(fetchImpl);
        const session = await requireSession(context, {} as never);
        expect(session.connection.instance).toEqual(profile.instance);
        expect((await loadConfig(context.configDir)).profiles["home"]?.instance).toEqual(
            profile.instance
        );
    });
});
