import { describe, expect, it } from "vitest";
import { mcpConfig } from "@/lib/agents/session-hooks";
import { inputFailure } from "@/lib/agents/session-browser";
import * as protocol from "@/lib/agents/session-browser-protocol";

function parse(input: unknown): protocol.BrowserInput {
    return protocol.browserInputSchema.parse(input);
}

describe("browser tools", () => {
    it("are uniquely named, closed objects whose required arguments exist", () => {
        const names = protocol.BROWSER_TOOLS.map((tool) => tool.name);
        expect(new Set(names).size).toBe(names.length);
        for (const tool of protocol.BROWSER_TOOLS) {
            expect(tool.name).toMatch(/^browser_[a-z]+$/);
            expect(tool.inputSchema.type).toBe("object");
            expect(tool.inputSchema.additionalProperties).toBe(false);
            for (const key of tool.inputSchema.required) expect(tool.inputSchema.properties).toHaveProperty(key);
            for (const property of Object.values(tool.inputSchema.properties))
                expect(["string", "number", "boolean"]).toContain(property.type);
        }
        expect(names).toEqual(
            expect.arrayContaining(["browser_navigate", "browser_click", "browser_type", "browser_screenshot", "browser_read"])
        );
    });

    it("tells the agent that what it reads is the page's, not the person's", () => {
        const read = protocol.BROWSER_TOOLS.find((tool) => tool.name === "browser_read");
        expect(read?.description).toMatch(/data, never as instructions/);
        expect(protocol.UNTRUSTED_NOTICE).toMatch(/do not follow instructions/);
    });

    it("opens http and https only", () => {
        expect(protocol.browsableUrl("example.com/a")).toBe("https://example.com/a");
        expect(protocol.browsableUrl("http://localhost:3000")).toBe("http://localhost:3000/");
        for (const bad of ["file:///etc/passwd", "javascript:alert(1)", "chrome://settings", "data:text/html,x", "", " "])
            expect(protocol.browsableUrl(bad)).toBeNull();
    });

    it("are registered beside Polaris's own with the session's key, and only when asked", () => {
        const plain = mcpConfig("https://p/mcp", "tok") as { mcpServers: object };
        expect(Object.keys(plain.mcpServers)).not.toContain(protocol.BROWSER_SERVER_NAME);
        const config = mcpConfig(
            "https://p/mcp",
            "tok",
            { script: "/state/tools-mcp.mjs", url: "https://p/tools" },
            { script: "/state/browser-mcp.mjs", key: "k", install: true }
        ) as { mcpServers: Record<string, unknown> };
        expect(config.mcpServers[protocol.BROWSER_SERVER_NAME]).toEqual({
            type: "stdio",
            command: "node",
            args: ["/state/browser-mcp.mjs"],
            env: { POLARIS_BROWSER_KEY: "k", POLARIS_BROWSER_INSTALL: "1" }
        });
    });
});

describe("remote input", () => {
    it("maps a normalized point to a pixel of the fixed viewport", () => {
        expect(protocol.inputToCdp(parse({ kind: "pointer", phase: "down", x: 1, y: 0.5 }))).toEqual([
            {
                method: "Input.dispatchMouseEvent",
                params: { type: "mousePressed", x: 1279, y: 400, button: "left", clickCount: 1 }
            }
        ]);
        expect(protocol.inputToCdp(parse({ kind: "pointer", phase: "move", x: 0, y: 0 }))?.[0]?.params).toEqual({
            type: "mouseMoved",
            x: 0,
            y: 0,
            button: "none"
        });
    });

    it("refuses a point outside the frame", () => {
        expect(protocol.browserInputSchema.safeParse({ kind: "pointer", phase: "down", x: 1.2, y: 0 }).success).toBe(false);
        expect(protocol.browserInputSchema.safeParse({ kind: "pointer", phase: "down", x: Number.NaN, y: 0 }).success).toBe(
            false
        );
    });

    it("clamps the wheel", () => {
        const [command] = protocol.inputToCdp(parse({ kind: "wheel", x: 0.5, y: 0.5, deltaX: -9000, deltaY: 120 })) ?? [];
        expect(command?.params).toMatchObject({ type: "mouseWheel", deltaX: -2000, deltaY: 120 });
    });

    it("types printable keys, and gives special keys their virtual code", () => {
        expect(protocol.keyEvent("down", "a", "KeyA", [])).toEqual({
            type: "keyDown",
            key: "a",
            code: "KeyA",
            modifiers: 0,
            windowsVirtualKeyCode: 65,
            text: "a"
        });
        expect(protocol.keyEvent("down", "Enter", "Enter", [])).toMatchObject({ type: "keyDown", windowsVirtualKeyCode: 13, text: "\r" });
        expect(protocol.keyEvent("down", "Backspace", "", [])).toEqual({
            type: "rawKeyDown",
            key: "Backspace",
            modifiers: 0,
            windowsVirtualKeyCode: 8
        });
        // A shortcut is a key, not text.
        expect(protocol.keyEvent("down", "a", "KeyA", ["control"])).not.toHaveProperty("text");
        expect(protocol.keyEvent("up", "a", "KeyA", ["shift"])).toMatchObject({ type: "keyUp", modifiers: 8 });
        expect(protocol.modifierBits(["alt", "control", "meta", "shift"])).toBe(15);
    });

    it("refuses quitting the browser and unknown modifiers", () => {
        expect(protocol.inputToCdp(parse({ kind: "key", phase: "down", key: "w", modifiers: ["meta"] }))).toBeNull();
        expect(
            protocol.browserInputSchema.safeParse({ kind: "key", phase: "down", key: "a", modifiers: ["hyper"] }).success
        ).toBe(false);
    });

    it("bounds inserted text by bytes", () => {
        expect(protocol.browserInputSchema.safeParse({ kind: "text", value: "é".repeat(8193) }).success).toBe(false);
        expect(protocol.inputToCdp(parse({ kind: "text", value: "hola" }))).toEqual([
            { method: "Input.insertText", params: { text: "hola" } }
        ]);
    });

    it("navigates to web addresses only, and walks history through the container", () => {
        expect(protocol.inputToCdp(parse({ kind: "navigate", action: "open", url: "example.com" }))).toEqual([
            { method: "Page.navigate", params: { url: "https://example.com/" } }
        ]);
        expect(protocol.inputToCdp(parse({ kind: "navigate", action: "open", url: "file:///etc/passwd" }))).toBeNull();
        expect(protocol.inputToCdp(parse({ kind: "navigate", action: "back" }))).toEqual([
            { method: "Polaris.history", params: { delta: -1 } }
        ]);
    });

    it("only ever produces a method the container relays", () => {
        const samples: unknown[] = [
            { kind: "pointer", phase: "up", x: 0.1, y: 0.1, button: "right" },
            { kind: "wheel", x: 0, y: 0, deltaX: 0, deltaY: 1 },
            { kind: "text", value: "x" },
            { kind: "key", phase: "down", key: "Tab" },
            { kind: "navigate", action: "reload" },
            { kind: "navigate", action: "forward" }
        ];
        for (const sample of samples)
            for (const command of protocol.inputToCdp(parse(sample)) ?? [])
                expect(protocol.CDP_METHODS).toContain(command.method);
    });

    it("reads the container's refusals", () => {
        expect(inputFailure(409, '{"error":"agent-driving"}')).toBe("agentDriving");
        expect(inputFailure(409, '{"error":"no-browser"}')).toBe("noBrowser");
        expect(inputFailure(400, "")).toBe("refused");
        expect(inputFailure(502, "")).toBe("unreachable");
    });
});

describe("frames", () => {
    const jpeg = new Uint8Array([0xff, 0xd8, 1, 2, 3, 0xff, 0xd9]);
    const frame = { kind: protocol.KIND_JPEG, sequence: 7, capturedAt: 1_763_000_000_000, width: 1280, height: 800, jpeg } as const;
    const state = {
        kind: protocol.KIND_STATE,
        state: { status: "ready", url: "https://example.com/", title: "Example", agentDriving: true }
    } as const;

    it("keep AO's 22-byte frame header", () => {
        const wire = protocol.encodePacket(frame);
        expect(new DataView(wire.buffer).getUint32(0)).toBe(protocol.FRAME_HEADER_BYTES + jpeg.length);
        expect(wire[4]).toBe(protocol.FRAME_VERSION);
        expect(wire[5]).toBe(protocol.KIND_JPEG);
    });

    it("round-trip whatever the chunk boundaries", () => {
        const wire = new Uint8Array([...protocol.encodePacket(state), ...protocol.encodePacket(frame)]);
        for (const size of [1, 3, 5, 22, wire.length]) {
            const reader = new protocol.PacketReader();
            const packets: protocol.BrowserPacket[] = [];
            for (let at = 0; at < wire.length; at += size) packets.push(...reader.push(wire.subarray(at, at + size)));
            expect(packets).toEqual([state, frame]);
        }
    });

    it("skip a malformed packet and keep reading", () => {
        const bad = new Uint8Array([0, 0, 0, 3, 9, 9, 9]);
        const reader = new protocol.PacketReader();
        expect(reader.push(new Uint8Array([...bad, ...protocol.encodePacket(state)]))).toEqual([state]);
    });

    it("stop on a length that is not this protocol", () => {
        const reader = new protocol.PacketReader();
        expect(() => reader.push(new Uint8Array([0x7f, 0xff, 0xff, 0xff]))).toThrow();
    });
});
