/**
 * The port 53 check: the query Polaris sends, how it reads the reply, and the
 * state the screen shows from it.
 *
 * Where the blocker stands is asked of the port itself, so a misread reply is a
 * screen that says blocking is on when it is not, or the other way round.
 */

import * as probe from "@/lib/dns-blocker/probe";
import { describe, expect, it, vi } from "vitest";

vi.mock("@polaris/db", () => ({ prisma: {} }));

const { stateOf } = await import("@/lib/dns-blocker/service");

/** A reply to `query` with A answers, each name compressed to the question's. */
function reply(query: Buffer, addresses: string[], rcode = 0): Buffer {
    const header = Buffer.from(query.subarray(0, 12));
    header.writeUInt16BE(0x8180 | rcode, 2);
    header.writeUInt16BE(addresses.length, 6);
    const answers = addresses.map((address) => {
        const record = Buffer.alloc(16);
        record.writeUInt16BE(0xc00c, 0);
        record.writeUInt16BE(1, 2);
        record.writeUInt16BE(1, 4);
        record.writeUInt32BE(60, 6);
        record.writeUInt16BE(4, 10);
        address.split(".").forEach((part, index) => record.writeUInt8(Number(part), 12 + index));
        return record;
    });
    return Buffer.concat([header, query.subarray(12), ...answers]);
}

describe("encodeQuery", () => {
    it("asks for one A record by labels, recursion desired", () => {
        const query = probe.encodeQuery(0x1234, "blocking-check.polaris.invalid");
        expect(query.readUInt16BE(0)).toBe(0x1234);
        expect(query.readUInt16BE(2)).toBe(0x0100);
        expect(query.readUInt16BE(4)).toBe(1);
        expect([...query.subarray(12)]).toEqual([
            14,
            ...Buffer.from("blocking-check"),
            7,
            ...Buffer.from("polaris"),
            7,
            ...Buffer.from("invalid"),
            0,
            0,
            1,
            0,
            1
        ]);
    });
});

describe("decodeReply", () => {
    const query = probe.encodeQuery(7, "ads.example.test");

    it("reads the addresses of a reply with a compressed name", () => {
        expect(probe.decodeReply(reply(query, ["0.0.0.0", "10.0.0.1"]), 7)).toEqual({
            rcode: 0,
            addresses: ["0.0.0.0", "10.0.0.1"]
        });
    });

    it("reads the response code of an answer with no addresses", () => {
        expect(probe.decodeReply(reply(query, [], 3), 7)).toEqual({ rcode: 3, addresses: [] });
    });

    it("ignores a packet for another query, a query itself, or a short one", () => {
        expect(probe.decodeReply(reply(query, ["0.0.0.0"]), 8)).toBeNull();
        expect(probe.decodeReply(query, 7)).toBeNull();
        expect(probe.decodeReply(Buffer.alloc(4), 7)).toBeNull();
    });

    it("keeps the response code of a truncated reply", () => {
        expect(probe.decodeReply(reply(query, ["0.0.0.0"]).subarray(0, 20), 7)).toEqual({
            rcode: 0,
            addresses: []
        });
    });
});

describe("answerBlocks", () => {
    it("is on only when the check name answered with the blocking address", () => {
        expect(probe.answerBlocks({ kind: "answered", rcode: 0, addresses: ["0.0.0.0"] })).toBe(
            true
        );
        expect(probe.answerBlocks({ kind: "answered", rcode: 3, addresses: [] })).toBe(false);
        expect(probe.answerBlocks({ kind: "answered", rcode: 0, addresses: ["203.0.113.5"] })).toBe(
            false
        );
        expect(probe.answerBlocks({ kind: "silent" })).toBe(false);
    });
});

describe("stateOf", () => {
    const silent: probe.DnsProbeAnswer = { kind: "silent" };
    const blocks: probe.DnsProbeAnswer = { kind: "answered", rcode: 0, addresses: ["0.0.0.0"] };
    const other: probe.DnsProbeAnswer = { kind: "answered", rcode: 0, addresses: ["203.0.113.5"] };
    const address = "192.168.1.5";

    it.each([
        [
            "no address",
            { address: null, engine: true, deployFailed: false, answer: blocks },
            "noAddress"
        ],
        ["off, port free", { address, engine: false, deployFailed: false, answer: silent }, "off"],
        [
            "off, something else answers",
            { address, engine: false, deployFailed: false, answer: other },
            "portTaken"
        ],
        [
            "on and blocking",
            { address, engine: true, deployFailed: false, answer: blocks },
            "blocking"
        ],
        [
            "on, something else answers",
            { address, engine: true, deployFailed: false, answer: other },
            "conflict"
        ],
        [
            "on, coming up",
            { address, engine: true, deployFailed: false, answer: silent },
            "starting"
        ],
        [
            "on, failed to bind",
            { address, engine: true, deployFailed: true, answer: silent },
            "portHeld"
        ]
    ] as const)("%s", (_label, input, expected) => {
        expect(stateOf(input)).toBe(expected);
    });
});
