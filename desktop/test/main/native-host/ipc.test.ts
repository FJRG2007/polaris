/**
 * The local endpoint matches the native host's, and a connection gets exactly
 * one answer: the handler's for a pairing, `bad-request` for anything else.
 */

import { connect } from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Server } from "node:net";
import { endpointFor, endpointUser, pipeName, socketDir } from "@/main/native-host/ipc-path";
import { listen } from "@/main/native-host/ipc-server";
import { frame } from "@/main/native-host/protocol";

describe("the endpoint", () => {
    it("names the pipe after the user, as the host does", () => {
        expect(endpointUser("Ana María")).toBe("ana_mar_a");
        expect(endpointUser("DOMAIN\\user")).toBe("domain_user");
        expect(pipeName("Ana María")).toBe("\\\\.\\pipe\\polaris-desktop-native-host-ana_mar_a");
        expect(endpointFor("win32", "Someone", "C:\\Users\\Someone", undefined)).toEqual({
            path: "\\\\.\\pipe\\polaris-desktop-native-host-someone",
            dir: null
        });
    });

    it("puts the socket in a private folder on macOS and Linux", () => {
        expect(socketDir("darwin", "/Users/a", "/x")).toBe("/Users/a/Library/Application Support/Polaris/native-host");
        expect(socketDir("linux", "/home/a", "/cfg")).toBe("/cfg/Polaris/native-host");
        expect(socketDir("linux", "/home/a", "relative")).toBe("/home/a/.config/Polaris/native-host");
        expect(socketDir("linux", "", undefined)).toBeNull();
        expect(endpointFor("linux", "a", "/home/a", undefined)).toEqual({
            path: "/home/a/.config/Polaris/native-host/desktop.sock",
            dir: "/home/a/.config/Polaris/native-host"
        });
    });
});

const NONCE = "AbCdEfGhIjKlMnOpQrStUvWxYz012345";

function framed(value: unknown): Buffer {
    const body = Buffer.from(typeof value === "string" ? value : JSON.stringify(value));
    const prefix = Buffer.alloc(4);
    prefix.writeUInt32LE(body.length, 0);
    return Buffer.concat([prefix, body]);
}

/** Send bytes in pieces and collect the answer. */
function exchange(path: string, pieces: Buffer[]): Promise<unknown> {
    return new Promise((resolve, reject) => {
        const socket = connect(path, () => {
            for (const piece of pieces) socket.write(piece);
        });
        let received = Buffer.alloc(0);
        socket.on("data", (chunk: Buffer) => (received = Buffer.concat([received, chunk])));
        socket.on("end", () => resolve(received.length >= 4 ? JSON.parse(received.subarray(4).toString()) : null));
        socket.on("error", reject);
    });
}

describe("the socket", () => {
    let server: Server | null = null;
    afterEach(() => {
        server?.close();
        server = null;
    });

    async function start(handler = vi.fn(async () => ({ ok: true as const }))) {
        const path =
            process.platform === "win32"
                ? `\\\\.\\pipe\\polaris-native-host-test-${process.pid}-${Math.random().toString(36).slice(2)}`
                : join(mkdtempSync(join(tmpdir(), "pnh-")), "private", "desktop.sock");
        server = await listen({ path, dir: process.platform === "win32" ? null : join(path, "..") }, handler);
        expect(server).not.toBeNull();
        return { path, handler };
    }

    it("hands a pairing split across writes to the handler and answers it", async () => {
        const { path, handler } = await start();
        const whole = framed({ type: "pair", server: "https://p.example", nonce: NONCE, caller: { browser: "firefox", id: "vault@polaris.local" } });
        const reply = await exchange(path, [whole.subarray(0, 3), whole.subarray(3, 20), whole.subarray(20)]);
        expect(reply).toEqual({ ok: true });
        expect(handler).toHaveBeenCalledWith(expect.objectContaining({ nonce: NONCE, server: "https://p.example" }));
    });

    it("answers anything else bad-request without calling the handler", async () => {
        const { path, handler } = await start();
        expect(await exchange(path, [framed("{bad")])).toEqual({ ok: false, reason: "bad-request" });
        const oversize = Buffer.alloc(4);
        oversize.writeUInt32LE(1 << 20, 0);
        expect(await exchange(path, [oversize])).toEqual({ ok: false, reason: "bad-request" });
        expect(handler).not.toHaveBeenCalled();
    });

    it("answers unreachable when the handler throws", async () => {
        const { path } = await start(vi.fn(async () => Promise.reject(new Error("boom"))));
        const message = framed({ type: "pair", server: "https://p.example", nonce: NONCE, caller: { browser: "firefox", id: "vault@polaris.local" } });
        expect(await exchange(path, [message])).toEqual({ ok: false, reason: "unreachable" });
    });

    it("frames replies the host can read", () => {
        expect(frame({ ok: true }).subarray(4).toString()).toBe('{"ok":true}');
    });
});
