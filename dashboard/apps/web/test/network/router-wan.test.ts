/**
 * The router's WAN address, as the mDNS responder asks it over NAT-PMP: the
 * gateway it asks, and how the answer is read.
 */

import { describe, expect, it } from "vitest";
import { defaultGateway, NAT_PMP_REQUEST, natPmpExternal } from "../../../../mdns/address.mjs";

const HEADER =
    "Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\t\tMTU\tWindow\tIRTT";

/** 192.168.1.1 and 192.168.2.1, little-endian as the kernel prints them. */
const ROUTER = "0101A8C0";
const OTHER = "0102A8C0";

describe("the gateway", () => {
    it("is the gateway of the best default route", () => {
        const table = [
            HEADER,
            `wlan0\t00000000\t${OTHER}\t0003\t0\t0\t600\t00000000\t0\t0\t0`,
            `eth0\t00000000\t${ROUTER}\t0003\t0\t0\t100\t00000000\t0\t0\t0`,
            "eth0\t0001A8C0\t00000000\t0001\t0\t0\t100\t00FFFFFF\t0\t0\t0"
        ].join("\n");
        expect(defaultGateway(table)).toBe("192.168.1.1");
    });

    it("is none without a routed default", () => {
        expect(defaultGateway("")).toBeNull();
        const down = [HEADER, `eth0\t00000000\t${ROUTER}\t0002\t0\t0\t100\t00000000\t0\t0\t0`];
        expect(defaultGateway(down.join("\n"))).toBeNull();
    });
});

describe("the NAT-PMP answer", () => {
    const answer = (bytes: number[]) => Uint8Array.from(bytes);

    it("asks for the external address with version 0, opcode 0", () => {
        expect([...NAT_PMP_REQUEST]).toEqual([0, 0]);
    });

    it("reads the external address of a successful reply", () => {
        expect(natPmpExternal(answer([0, 128, 0, 0, 0, 0, 0, 9, 100, 64, 0, 7]))).toBe(
            "100.64.0.7"
        );
    });

    it("refuses an error, another opcode, a short reply and an empty address", () => {
        expect(natPmpExternal(answer([0, 128, 0, 3, 0, 0, 0, 9, 100, 64, 0, 7]))).toBeNull();
        expect(natPmpExternal(answer([0, 129, 0, 0, 0, 0, 0, 9, 100, 64, 0, 7]))).toBeNull();
        expect(natPmpExternal(answer([0, 128, 0, 0]))).toBeNull();
        expect(natPmpExternal(answer([0, 128, 0, 0, 0, 0, 0, 9, 0, 0, 0, 0]))).toBeNull();
    });
});
