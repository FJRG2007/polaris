/**
 * Which address the worker sends to: the usual one, or a local address of the
 * same Polaris once it has signed a fresh challenge - and only one this browser
 * may reach. Driven against WXT's fake browser with a fake network.
 */

import { fakeBrowser } from "wxt/testing/fake-browser";
import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { localPermissions, plainOrigin } from "../src/lib/local-address";
import { challengeMessage } from "../../../packages/core/src/instance-fallback";

const PRIMARY = "https://polaris.example.com";
const LAN = "https://192.168.1.20";
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

type Node = "up" | "down" | "impostor" | "plain-only";

let nodes: Record<string, Node> = {};
let granted = new Set<string>();
let sent: { url: string; authorization: string | null }[] = [];

async function network(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
    const url = new URL(String(input));
    sent.push({ url: url.href, authorization: new Headers(init.headers).get("authorization") });
    const node = nodes[url.origin] ?? "down";
    if (node === "down") throw new TypeError("Failed to fetch");
    if (node === "plain-only") {
        if (url.protocol === "http:") return new Response(null, { status: 308 });
        throw new TypeError("Failed to fetch");
    }
    if (url.pathname === "/api/instance/challenge") {
        const { nonce } = JSON.parse(String(init.body)) as { nonce: string };
        const key = node === "impostor" ? impostor.privateKey : real.privateKey;
        const signature = sign(null, Buffer.from(challengeMessage(ID, url.origin, nonce)), key);
        return Response.json({ id: ID, nonce, signature: signature.toString("base64url") });
    }
    return Response.json({ id: ID, publicKey: real.publicKey, addresses: [PRIMARY, LAN] });
}

async function load() {
    vi.resetModules();
    return import("../src/lib/reach");
}

beforeEach(async () => {
    fakeBrowser.reset();
    nodes = {};
    granted = new Set([`${PRIMARY}/*`]);
    sent = [];
    vi.stubGlobal("fetch", vi.fn(network));
    fakeBrowser.permissions.contains = vi.fn(async ({ origins = [] }: { origins?: string[] }) =>
        origins.every((one: string) => granted.has(one))
    ) as typeof fakeBrowser.permissions.contains;
    await fakeBrowser.storage.local.set({
        "server.origin": PRIMARY,
        "server.instance": {
            origin: PRIMARY,
            record: { id: ID, publicKey: real.publicKey, addresses: [PRIMARY, LAN] },
            learnedAt: Date.now()
        }
    });
});

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("reachOrigin", () => {
    it("uses the local address once it proves it, and says so", async () => {
        nodes = { [LAN]: "up" };
        granted.add(`${LAN}/*`);
        const reach = await load();
        expect(await reach.reachOrigin()).toBe(LAN);
        expect((await reach.reachStatus()).local).toBe(true);
    });

    it("stays on the usual address while it answers", async () => {
        nodes = { [PRIMARY]: "up", [LAN]: "up" };
        granted.add(`${LAN}/*`);
        const reach = await load();
        expect(await reach.reachOrigin()).toBe(PRIMARY);
        expect(sent.some((one) => one.url.startsWith(LAN))).toBe(false);
    });

    it("never touches a local address it holds no permission for, and names it", async () => {
        nodes = { [LAN]: "up" };
        const reach = await load();
        expect(await reach.reachOrigin()).toBe(PRIMARY);
        expect(sent.some((one) => one.url.startsWith(LAN))).toBe(false);
        expect((await reach.reachStatus()).missing).toEqual([LAN]);
    });

    it("refuses an address that signs with another key", async () => {
        nodes = { [LAN]: "impostor" };
        granted.add(`${LAN}/*`);
        const reach = await load();
        expect(await reach.reachOrigin()).toBe(PRIMARY);
        expect((await reach.reachStatus()).refused).toEqual(["192.168.1.20"]);
    });

    it("tells an untrusted certificate from an address that is not there", async () => {
        nodes = { [LAN]: "plain-only", "http://192.168.1.20": "plain-only" };
        granted.add(`${LAN}/*`).add("http://192.168.1.20/*");
        const reach = await load();
        expect(await reach.reachOrigin()).toBe(PRIMARY);
        expect((await reach.reachStatus()).untrusted).toBe(true);
    });
});

describe("local permissions", () => {
    it("ask for the address and the same host without TLS", () => {
        expect(plainOrigin("https://polaris.local:8443")).toBe("http://polaris.local");
        expect(localPermissions(["https://polaris.local", LAN])).toEqual([
            "https://polaris.local/*",
            "http://polaris.local/*",
            `${LAN}/*`,
            "http://192.168.1.20/*"
        ]);
    });
});
