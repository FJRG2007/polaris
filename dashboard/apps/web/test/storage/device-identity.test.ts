/**
 * The rule that decides whether a storage's password may go to whatever answers
 * at an address.
 *
 * A name is never proof - two boxes out of the same carton share one, and an
 * impostor copies it first. A hardware address or an SMB server GUID has to
 * agree, and one that disagrees is forgiven only for the two honest changes: the
 * other network port, or a GUID regenerated on restart.
 */

import { describe, expect, it } from "vitest";
import { parseNeighbourTable } from "@/lib/storage-whereabouts/neighbours";
import {
    canConfirm,
    compareIdentity,
    mergeIdentity,
    neighbourhoodOf,
    normalizeMac,
    readRemembered
} from "@/lib/storage-whereabouts/identity";

const NAS = {
    mac: "00:00:5e:00:53:10",
    serverGuid: "0123456789abcdef0123456789abcdef",
    netbiosName: "OFFICE-NAS"
};

describe("whether it is the same device", () => {
    it("is when the hardware address and the GUID agree", () => {
        expect(compareIdentity(NAS, { ...NAS })).toBe("same");
    });

    it("is on the GUID alone, as in the limited edition with no neighbour table", () => {
        expect(
            compareIdentity(NAS, { serverGuid: NAS.serverGuid, netbiosName: "OFFICE-NAS" })
        ).toBe("same");
    });

    it("is on the hardware address alone", () => {
        expect(compareIdentity(NAS, { mac: "00-00-5E-00-53-10" })).toBe("same");
    });

    it("is not on a matching name alone", () => {
        expect(compareIdentity(NAS, { netbiosName: "office-nas" })).toBe("unknown");
    });

    it("is a different device when everything it says disagrees", () => {
        expect(
            compareIdentity(NAS, {
                mac: "aa:bb:cc:dd:ee:ff",
                serverGuid: "ffffffffffffffffffffffffffff0000",
                netbiosName: "OFFICE-NAS"
            })
        ).toBe("different");
    });

    it("is a different device when only a different name answers", () => {
        expect(compareIdentity(NAS, { netbiosName: "DESKTOP-1" })).toBe("different");
    });

    it("forgives a regenerated GUID when the hardware address and the name agree", () => {
        expect(
            compareIdentity(NAS, { ...NAS, serverGuid: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" })
        ).toBe("same");
    });

    it("forgives the other network port when the GUID and the name agree", () => {
        expect(compareIdentity(NAS, { ...NAS, mac: "00:00:5e:00:53:11" })).toBe("same");
    });

    it("does not forgive a changed fact under a different name", () => {
        expect(
            compareIdentity(NAS, {
                ...NAS,
                serverGuid: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                netbiosName: "OTHER"
            })
        ).toBe("different");
    });

    it("cannot confirm anything with nothing remembered", () => {
        expect(compareIdentity(null, NAS)).toBe("unknown");
        expect(canConfirm({ netbiosName: "OFFICE-NAS" })).toBe(false);
        expect(canConfirm({ serverGuid: "00000000000000000000000000000000" })).toBe(false);
        expect(canConfirm(NAS)).toBe(true);
    });
});

describe("the pieces", () => {
    it("normalizes hardware addresses and drops the empty ones", () => {
        expect(normalizeMac("00:00:5E:00:53:50")).toBe("00:00:5e:00:53:50");
        expect(normalizeMac("00:00:00:00:00:00")).toBeUndefined();
        expect(normalizeMac("garbage")).toBeUndefined();
    });

    it("reads a stored identity defensively", () => {
        expect(
            readRemembered({ ...NAS, address: "10.0.1.129", seenAt: "2026-10-01T12:00:00.000Z" })
        ).toMatchObject(NAS);
        expect(readRemembered({ mac: "not a mac", address: "x", seenAt: "y" })).toBeNull();
        expect(readRemembered(null)).toBeNull();
    });

    it("merges a fresh observation over what was remembered", () => {
        const merged = mergeIdentity(
            NAS,
            { serverGuid: "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB" },
            "10.0.1.134",
            new Date(0)
        );
        expect(merged).toMatchObject({
            mac: NAS.mac,
            serverGuid: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            netbiosName: "OFFICE-NAS",
            address: "10.0.1.134"
        });
    });

    it("looks through the /24 nearest first, never at itself or past it", () => {
        const order = neighbourhoodOf("10.0.1.129");
        expect(order.slice(0, 4)).toEqual(["10.0.1.130", "10.0.1.128", "10.0.1.131", "10.0.1.127"]);
        expect(order).toHaveLength(253);
        expect(order).not.toContain("10.0.1.129");
        expect(order).not.toContain("10.0.1.0");
        expect(order).not.toContain("10.0.1.255");
    });

    it("never sweeps a public network", () => {
        expect(neighbourhoodOf("8.8.8.8")).toEqual([]);
        expect(neighbourhoodOf("nas.example")).toEqual([]);
    });

    it("reads complete neighbour entries and skips the incomplete ones", () => {
        const table = parseNeighbourTable(
            [
                "10.0.1.1 0x2 aa:bb:cc:dd:ee:01",
                "10.0.1.129 0x0 00:00:00:00:00:00",
                "10.0.1.134 0x2 00:00:5E:00:53:50",
                "10.0.1.200 0x6 aa:bb:cc:dd:ee:02",
                "garbage line"
            ].join("\n")
        );
        expect([...table]).toEqual([
            ["10.0.1.1", "aa:bb:cc:dd:ee:01"],
            ["10.0.1.134", "00:00:5e:00:53:50"],
            ["10.0.1.200", "aa:bb:cc:dd:ee:02"]
        ]);
    });
});
