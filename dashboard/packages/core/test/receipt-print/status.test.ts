/**
 * Printer status bytes to the reason shown on screen, and the addresses a raw
 * print socket may be opened to.
 */

import { describe, expect, it } from "vitest";
import * as print from "../../src/receipt-print/index.js";

describe("readStatus", () => {
    it("reads a ready printer as ready", () => {
        expect(print.readStatus(0x12, 0x12, 0x12)).toEqual({ problem: null, paperLow: false });
    });

    it("names paper out before anything it causes", () => {
        // Paper end sets the roll bits and, on most models, offline and "stopped for paper" too.
        expect(print.readStatus(0x1a, 0x32, 0x72).problem).toBe("paper-out");
        expect(print.readStatus(0x1a, 0x32, undefined).problem).toBe("paper-out");
    });

    it("names an open cover", () => {
        expect(print.readStatus(0x1a, 0x16, 0x12).problem).toBe("cover-open");
    });

    it("warns about a roll near its end without stopping the print", () => {
        expect(print.readStatus(0x12, 0x12, 0x1e)).toEqual({ problem: null, paperLow: true });
    });

    it("reads an error and a bare offline", () => {
        expect(print.readStatus(0x1a, 0x52, 0x12).problem).toBe("error");
        expect(print.readStatus(0x1a, 0x12, 0x12).problem).toBe("offline");
    });

    it("tells a device that does not answer like a printer", () => {
        expect(print.readStatus(undefined, undefined, undefined).problem).toBe("not-a-printer");
        expect(print.readStatus(0x48, 0x12, 0x12).problem).toBe("not-a-printer");
        // A compatible that answers only n = 1 is ready.
        expect(print.readStatus(0x16, undefined, undefined).problem).toBe(null);
    });
});

describe("isPrinterAddress", () => {
    it("accepts the local network and self-assigned addresses", () => {
        for (const address of ["192.168.1.50", "10.0.0.7", "172.16.4.2", "169.254.10.3"]) {
            expect(print.isPrinterAddress(address)).toBe(true);
        }
    });

    it("refuses loopback, the internet, hostnames and IPv6", () => {
        for (const address of ["127.0.0.1", "8.8.8.8", "172.32.0.1", "printer.local", "::ffff:192.168.1.5", "fe80::1", ""]) {
            expect(print.isPrinterAddress(address)).toBe(false);
        }
    });

    it("allows only the raw print ports", () => {
        expect(print.isPrinterPort(9100)).toBe(true);
        expect(print.isPrinterPort(22)).toBe(false);
        expect(print.isPrinterPort(5432)).toBe(false);
    });
});
