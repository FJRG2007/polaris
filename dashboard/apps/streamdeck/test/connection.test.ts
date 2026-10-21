/**
 * Talking to Polaris: the address as typed, the server-sent event reader, the
 * reconnect backoff, stored credentials, and the client against a stubbed
 * Polaris.
 */

import { SseReader } from "../src/sse";
import { backoffMs } from "../src/backoff";
import { describe, expect, it, vi } from "vitest";
import { joinPath, normalizeAddress } from "../src/address";
import { PolarisClient, readCredentials, Unauthorized, userAgent } from "../src/polaris";

describe("normalizeAddress", () => {
    it("takes a bare host as https and keeps only scheme, host and port", () => {
        expect(normalizeAddress(" polaris.example.com/ ")).toBe("https://polaris.example.com");
        expect(normalizeAddress("http://10.0.0.5:3000/home")).toBe("http://10.0.0.5:3000");
    });

    it("refuses what is not an http address, or carries credentials", () => {
        expect(normalizeAddress("")).toBeNull();
        expect(normalizeAddress("ftp://polaris.example.com")).toBeNull();
        expect(normalizeAddress("javascript:alert(1)")).toBeNull();
        expect(normalizeAddress("https://user:pass@polaris.example.com")).toBeNull();
    });
});

describe("joinPath", () => {
    it("joins a Polaris path and refuses one that would leave the address", () => {
        expect(joinPath("https://polaris.example.com", "/chat")).toBe(
            "https://polaris.example.com/chat"
        );
        expect(joinPath("https://polaris.example.com", "//evil.example")).toBeNull();
        expect(joinPath("https://polaris.example.com", "https://evil.example")).toBeNull();
        expect(joinPath("https://polaris.example.com", "/a\\b")).toBeNull();
    });
});

describe("SseReader", () => {
    it("yields whole events from chunks split anywhere", () => {
        const reader = new SseReader();
        expect(reader.push("retry: 5000\n\nevent: sta")).toEqual([]);
        expect(reader.push('te\ndata: {"a":')).toEqual([]);
        expect(reader.push("1}\n\n: keep-alive\n\ndata: x\r\ndata: y\r\n\r\n")).toEqual([
            { event: "state", data: '{"a":1}' },
            { event: "message", data: "x\ny" }
        ]);
        expect(reader.retryMs).toBe(5000);
    });
});

describe("backoffMs", () => {
    it("doubles from a second to a minute, within a fifth either way", () => {
        expect(backoffMs(0, () => 0.5)).toBe(1000);
        expect(backoffMs(3, () => 0.5)).toBe(8000);
        expect(backoffMs(30, () => 0.5)).toBe(60_000);
        expect(backoffMs(3, () => 1)).toBe(9600);
        expect(backoffMs(3, () => 0)).toBe(6400);
    });
});

describe("readCredentials", () => {
    it("keeps a stored connection and drops anything incomplete", () => {
        expect(
            readCredentials({ address: "https://p.example", token: "plk_x", account: "Ada" })
        ).toEqual({
            address: "https://p.example",
            token: "plk_x",
            account: "Ada"
        });
        expect(readCredentials({ address: "https://p.example" })).toBeNull();
        expect(readCredentials(null)).toBeNull();
    });
});

describe("PolarisClient", () => {
    const credentials = { address: "https://p.example", token: "plk_secret" };

    function stub(responses: Response[]) {
        const calls: { url: string; init: RequestInit | undefined }[] = [];
        const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
            calls.push({ url: String(url), init });
            return responses.shift()!;
        });
        return { client: new PolarisClient("0.1.0", fetcher as unknown as typeof fetch), calls };
    }

    it("presents the key and a user-agent Polaris reads the system from", async () => {
        const { client, calls } = stub([Response.json({ actions: [{ id: "chat.unread" }] })]);
        expect(await client.catalogue(credentials)).toEqual([{ id: "chat.unread" }]);
        const headers = calls[0]!.init!.headers as Record<string, string>;
        expect(calls[0]!.url).toBe("https://p.example/api/deck/actions");
        expect(headers.authorization).toBe("Bearer plk_secret");
        expect(headers["user-agent"]).toBe(userAgent("0.1.0"));
        expect(userAgent("0.1.0")).toMatch(
            /^polaris-streamdeck\/0\.1\.0 \((win32|darwin|linux|\w+); /
        );
    });

    it("reports a 401 as the key no longer working", async () => {
        const { client } = stub([new Response(null, { status: 401 })]);
        await expect(client.catalogue(credentials)).rejects.toBeInstanceOf(Unauthorized);
    });

    it("hands a refusal back as Polaris worded it", async () => {
        const { client, calls } = stub([
            Response.json({ ok: false, message: "Not set up" }, { status: 422 })
        ]);
        expect(await client.run(credentials, "chat.send", { body: "hi" })).toEqual({
            ok: false,
            message: "Not set up"
        });
        expect(JSON.parse(String(calls[0]!.init!.body))).toEqual({
            action: "chat.send",
            options: { body: "hi" }
        });
    });

    it("opens a connection request with this computer's name and claims it", async () => {
        const { client, calls } = stub([
            Response.json({
                userCode: "BCDF",
                deviceCode: "d",
                pollMs: 2000,
                expiresAt: "x",
                approvePath: "/a"
            }),
            Response.json({ status: "pending" })
        ]);
        expect((await client.open("https://p.example")).userCode).toBe("BCDF");
        expect(await client.claim("https://p.example", "d")).toEqual({ status: "pending" });
        expect(calls[0]!.url).toBe("https://p.example/api/deck/authorize");
        expect(JSON.parse(String(calls[0]!.init!.body))).toMatchObject({ clientVersion: "0.1.0" });
        expect(calls[1]!.url).toBe("https://p.example/api/deck/authorize/claim");
    });

    it("reads state frames off the stream and skips everything else", async () => {
        const body = new ReadableStream<Uint8Array>({
            start(controller) {
                const encoder = new TextEncoder();
                controller.enqueue(
                    encoder.encode('retry: 5000\n\nevent: state\ndata: {"readings":[{"key":"a",')
                );
                controller.enqueue(
                    encoder.encode(
                        '"state":{"tone":"ok"}}]}\n\n: keep-alive\n\nevent: other\ndata: 1\n\n'
                    )
                );
                controller.close();
            }
        });
        const { client, calls } = stub([
            new Response(body, { headers: { "content-type": "text/event-stream" } })
        ]);
        const seen: unknown[] = [];
        await client.stream(
            credentials,
            [{ key: "a", action: "chat.unread", options: {} }],
            (readings) => seen.push(readings),
            new AbortController().signal
        );
        expect(seen).toEqual([[{ key: "a", state: { tone: "ok" } }]]);
        const watch = new URL(calls[0]!.url).searchParams.get("watch")!;
        expect(JSON.parse(Buffer.from(watch, "base64url").toString())).toEqual([
            { key: "a", action: "chat.unread", options: {} }
        ]);
    });

    it("takes an already revoked key as disconnected", async () => {
        const { client } = stub([new Response(null, { status: 401 })]);
        await expect(client.end(credentials)).resolves.toBeUndefined();
    });
});
