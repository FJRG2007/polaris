import { RECORDED } from "./fake-pipe";
import { describe, expect, it } from "vitest";
import { readFrame } from "@/lib/agents/acp/frames";

describe("readFrame", () => {
    it("accepts every recorded frame", () => {
        for (const frame of RECORDED) expect(readFrame(frame)).toEqual(frame);
    });

    it("accepts an error response, also one with no id", () => {
        const error = { jsonrpc: "2.0", id: 3, error: { code: -32601, message: "Method not found" } };
        expect(readFrame(error)).toEqual(error);
        expect(readFrame({ ...error, id: null })).not.toBeNull();
    });

    it("refuses what is not one JSON-RPC 2.0 frame", () => {
        expect(readFrame(null)).toBeNull();
        expect(readFrame([RECORDED[0]])).toBeNull();
        expect(readFrame({ jsonrpc: "1.0", method: "session/update" })).toBeNull();
        expect(readFrame({ jsonrpc: "2.0", id: 1 })).toBeNull();
        expect(readFrame({ jsonrpc: "2.0", id: 1, result: {}, error: { code: 1, message: "x" } })).toBeNull();
        expect(readFrame({ jsonrpc: "2.0", method: "" })).toBeNull();
        expect(readFrame({ jsonrpc: "2.0", method: "x".repeat(201) })).toBeNull();
        expect(readFrame({ jsonrpc: "2.0", id: { nested: true }, method: "x" })).toBeNull();
        expect(readFrame({ jsonrpc: "2.0", method: "x", params: "text" })).toBeNull();
    });
});
