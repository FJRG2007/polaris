/**
 * The local socket accepts exactly one pairing message per connection and
 * nothing else.
 */

import { describe, expect, it } from "vitest";
import { frame, readFrame } from "@/main/native-host/protocol";

const NONCE = "AbCdEfGhIjKlMnOpQrStUvWxYz012345_-";
const CALLER = { browser: "chromium", id: "abcdefghijklmnopabcdefghijklmnop" };

function framed(value: unknown): Buffer {
    const body = Buffer.from(typeof value === "string" ? value : JSON.stringify(value), "utf8");
    const prefix = Buffer.alloc(4);
    prefix.writeUInt32LE(body.length, 0);
    return Buffer.concat([prefix, body]);
}

const valid = { type: "pair", server: "https://polaris.example/", nonce: NONCE, caller: CALLER };

describe("reading the host's message", () => {
    it("accepts a pairing and reduces the server to its origin", () => {
        const read = readFrame(framed(valid));
        expect(read).toEqual({ kind: "message", message: { ...valid, server: "https://polaris.example" } });
    });

    it("accepts a terminal's sign-in code, and nothing more in it", () => {
        const terminal = { type: "terminal-sign-in", server: "https://polaris.example/", userCode: "BCDF-GHJK" };
        expect(readFrame(framed(terminal))).toEqual({
            kind: "message",
            message: { ...terminal, server: "https://polaris.example" }
        });
        expect(readFrame(framed({ ...terminal, token: "x" })).kind).toBe("invalid");
        expect(readFrame(framed({ ...terminal, userCode: "../../etc" })).kind).toBe("invalid");
    });

    it("waits for the rest of a message split across reads", () => {
        const whole = framed(valid);
        expect(readFrame(whole.subarray(0, 2)).kind).toBe("partial");
        expect(readFrame(whole.subarray(0, whole.length - 1)).kind).toBe("partial");
        expect(readFrame(whole).kind).toBe("message");
    });

    it("refuses an oversize length before the body arrives", () => {
        const prefix = Buffer.alloc(4);
        prefix.writeUInt32LE(4097, 0);
        expect(readFrame(prefix)).toMatchObject({ kind: "invalid" });
    });

    it("refuses bytes that are not JSON, and a second message", () => {
        expect(readFrame(framed("{nope"))).toMatchObject({ kind: "invalid", why: "not JSON" });
        expect(readFrame(Buffer.concat([framed(valid), framed(valid)]))).toMatchObject({ kind: "invalid" });
    });

    it.each([
        ["another type", { ...valid, type: "unlock" }],
        ["an extra field", { ...valid, extra: true }],
        ["a short nonce", { ...valid, nonce: "short" }],
        ["a nonce with other characters", { ...valid, nonce: `${NONCE}=` }],
        ["a non-web server", { ...valid, server: "file:///etc/passwd" }],
        ["a server that is not a URL", { ...valid, server: "polaris" }],
        ["no caller", { ...valid, caller: undefined }],
        ["a malformed Chromium id", { ...valid, caller: { browser: "chromium", id: "ABC" } }],
        ["an unknown browser", { ...valid, caller: { browser: "safari", id: "x" } }],
        ["an array", [valid]]
    ])("refuses %s", (_name, value) => {
        expect(readFrame(framed(value))).toMatchObject({ kind: "invalid" });
    });
});

describe("framing the reply", () => {
    it("writes a little-endian length and the JSON", () => {
        const out = frame({ ok: false, reason: "signed-out" });
        expect(out.readUInt32LE(0)).toBe(out.length - 4);
        expect(JSON.parse(out.subarray(4).toString("utf8"))).toEqual({ ok: false, reason: "signed-out" });
    });
});
