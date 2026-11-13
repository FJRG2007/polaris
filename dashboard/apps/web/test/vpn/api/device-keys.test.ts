import { describe, expect, it } from "vitest";
import { headscaleClient } from "@/lib/vpn/headscale-client";
import { connectCommand, deviceKeysOf, keyState } from "@/lib/vpn/device-keys";


interface StoredKey {
    id: string;
    key: string;
    user: { id: string; name: string };
    reusable: boolean;
    ephemeral: boolean;
    used: boolean;
    expiration: string;
    created_at: string;
    acl_tags: string[];
}

/**
 * A control server that keeps its keys in memory and answers the way a newer
 * one does: snake_case JSON, every user's keys on a listing, expiry by id.
 */
function fakeControlServer() {
    const keys: StoredKey[] = [];
    let next = 1;
    const users: Record<string, string> = { "3": "polaris-u1", "4": "polaris-u2" };
    const fetcher = async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(String(input));
        const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
        const json = (value: unknown, status = 200) =>
            new Response(JSON.stringify(value), { status });
        if (url.pathname === "/api/v1/preauthkey" && init?.method === "POST") {
            const id = String(next++);
            const stored: StoredKey = {
                id,
                key: `hskey-auth-${id}abcdefghijklmnop`,
                user: { id: String(body.user), name: users[String(body.user)] ?? "?" },
                reusable: body.reusable === true,
                ephemeral: body.ephemeral === true,
                used: false,
                expiration: String(body.expiration),
                created_at: `2026-11-13T10:00:0${id}Z`,
                acl_tags: (body.acl_tags as string[] | undefined) ?? []
            };
            keys.push(stored);
            return json({ pre_auth_key: stored });
        }
        if (url.pathname === "/api/v1/preauthkey" && init?.method === "GET")
            return json({ pre_auth_keys: keys });
        if (url.pathname === "/api/v1/preauthkey/expire" && init?.method === "POST") {
            const found = keys.find((key) => key.id === String(body.id));
            if (!found) return json({ message: "not found" }, 404);
            found.expiration = new Date(Date.now() - 1000).toISOString();
            return json({});
        }
        return json({ message: "no route" }, 404);
    };
    return { keys, api: headscaleClient("http://h:1", "secret", fetcher as typeof fetch) };
}

describe("VPN device keys against a control server", () => {
    it("are listed after they are made, revoked there, and shown expired", async () => {
        const server = fakeControlServer();
        const expiration = new Date(Date.now() + 3_600_000);
        const made = await server.api.createPreAuthKey({
            userId: "3",
            reusable: false,
            ephemeral: false,
            expiration
        });
        // Somebody else's key, and a gateway's tagged key, never reach the list.
        await server.api.createPreAuthKey({ userId: "4", reusable: false, ephemeral: false, expiration });
        await server.api.createPreAuthKey({
            userId: "3",
            reusable: false,
            ephemeral: false,
            expiration,
            tags: ["tag:polaris"]
        });

        let listed = deviceKeysOf(await server.api.listPreAuthKeys("3"), "3", Date.now());
        expect(listed).toHaveLength(1);
        expect(listed[0]).toMatchObject({ id: made.id, state: "unused" });
        // The value is never handed back whole.
        expect(listed[0]?.hint).not.toBe(made.key);
        expect(made.key.startsWith(listed[0]?.hint.replace("...", "") ?? "x")).toBe(true);

        await server.api.expirePreAuthKey({ id: made.id, userId: "3", key: made.key });
        listed = deviceKeysOf(await server.api.listPreAuthKeys("3"), "3", Date.now());
        expect(listed[0]?.state).toBe("expired");
    });

    it("sends what both older and newer servers read to expire a key", async () => {
        let sent: unknown = null;
        const api = headscaleClient("http://h:1", "s", (async (_: unknown, init?: RequestInit) => {
            sent = JSON.parse(String(init?.body));
            return new Response("{}");
        }) as typeof fetch);
        await api.expirePreAuthKey({ id: "9", userId: "3", key: "hskey-auth-x" });
        expect(sent).toEqual({ id: "9", user: "3", key: "hskey-auth-x" });
    });

    it("reads a used one-time key as used and a used reusable one as unused", () => {
        const base = {
            id: "1",
            key: "k",
            ephemeral: false,
            expiration: null,
            createdAt: null,
            aclTags: [],
            user: null
        };
        expect(keyState({ ...base, used: true, reusable: false }, 0)).toBe("used");
        expect(keyState({ ...base, used: true, reusable: true }, 0)).toBe("unused");
    });

    it("fills the connect command with the real key", () => {
        expect(connectCommand("https://vpn.example.test", "hskey-1")).toBe(
            "tailscale up --login-server=https://vpn.example.test --authkey=hskey-1"
        );
    });
});
