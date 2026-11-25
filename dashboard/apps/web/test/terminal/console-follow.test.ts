/**
 * The sidecar's game console mode (`console-follow.mjs`).
 *
 * Pinned: it follows the container's log through the daemon with the recent
 * lines first, writes what is printed to the socket, ends the socket when the
 * container stops, closes the follow when the browser leaves, and never writes
 * what the browser sends anywhere - a command goes through the console's action.
 */

import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { CONSOLE_HISTORY_LINES, followConsole } from "../../console-follow.mjs";

class FakeSocket extends EventEmitter {
    public readonly OPEN = 1;
    public readyState = 1;
    public bufferedAmount = 0;
    public readonly sent: string[] = [];
    public closed: { code: number; reason: string } | null = null;
    public send(chunk: Buffer | string, done?: () => void): void {
        this.sent.push(chunk.toString());
        done?.();
    }
    public close(code: number, reason: string): void {
        this.closed ??= { code, reason };
        this.readyState = 3;
        this.emit("close");
    }
}

const TICKET = { userId: "u1", containerRef: "polaris-mc-1", mode: "console" };

function logStream(): PassThrough & { statusCode: number } {
    return Object.assign(new PassThrough(), { statusCode: 200 });
}

describe("followConsole", () => {
    it("streams the history and then the live output to the socket", async () => {
        const stream = logStream();
        const openLogs = vi.fn(async () => stream);
        const ws = new FakeSocket();
        const live = new Map();
        await followConsole(TICKET, ws, { openLogs, live });

        expect(openLogs).toHaveBeenCalledWith({
            container: "polaris-mc-1",
            follow: true,
            tail: CONSOLE_HISTORY_LINES
        });
        expect(live.get(ws)).toBe("u1");
        stream.write("2026-11-25T10:00:00.000Z [Server] Done\n");
        stream.write("2026-11-25T10:00:01.000Z Steve joined the game\n");
        await new Promise((resolve) => setImmediate(resolve));
        expect(ws.sent.join("")).toContain("Steve joined the game");

        stream.end();
        await new Promise((resolve) => setImmediate(resolve));
        expect(ws.closed?.code).toBe(1000);
        expect(live.has(ws)).toBe(false);
    });

    it("drops whatever the browser sends and ends the follow when it leaves", async () => {
        const stream = logStream();
        const written = vi.spyOn(stream, "write");
        const ws = new FakeSocket();
        await followConsole(TICKET, ws, { openLogs: async () => stream, live: new Map() });

        ws.emit("message", Buffer.from("op Steve\r"), false);
        expect(written).not.toHaveBeenCalled();
        ws.close(1000, "left");
        expect(stream.destroyed).toBe(true);
    });

    it("closes with a reason when the daemon cannot follow the log", async () => {
        const ws = new FakeSocket();
        await followConsole(TICKET, ws, {
            openLogs: async () => {
                throw new Error("hostd down");
            },
            live: new Map()
        });
        expect(ws.closed).toEqual({ code: 4002, reason: "could not open console" });
    });
});
