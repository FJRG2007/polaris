/**
 * Where a typed connection may point. The cases that matter are the ones that
 * would have let somebody reach what only Polaris can see: its loopback, the
 * cloud metadata service, the house network, a name that resolves to one of
 * them, and an IPv4 address dressed up as IPv6.
 */

import { describe, expect, it } from "vitest";
import { classifyAddress, resolveEgress, EgressRefusal, type Lookup } from "@/lib/data/egress";

const answers =
    (table: Record<string, string[]>): Lookup =>
    async (host) =>
        (table[host] ?? []).map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));

describe("classifyAddress", () => {
    it("never allows link-local, metadata, unspecified or multicast", () => {
        for (const address of [
            "169.254.169.254",
            "100.100.100.200",
            "0.0.0.0",
            "224.0.0.1",
            "255.255.255.255",
            "fe80::1",
            "fd00:ec2::254",
            "::",
            "ff02::1"
        ]) {
            expect(classifyAddress(address), address).toBe("forbidden");
        }
    });

    it("calls loopback and private ranges internal", () => {
        for (const address of [
            "127.0.0.1",
            "10.1.2.3",
            "172.20.0.5",
            "192.168.1.10",
            "100.64.0.1",
            "::1",
            "fd12::1"
        ]) {
            expect(classifyAddress(address), address).toBe("internal");
        }
    });

    it("judges an IPv4 address inside IPv6 as the IPv4 address it is", () => {
        expect(classifyAddress("::ffff:127.0.0.1")).toBe("internal");
        expect(classifyAddress("::ffff:a9fe:a9fe")).toBe("forbidden");
        expect(classifyAddress("64:ff9b::10.0.0.1")).toBe("internal");
    });

    it("lets a public address through", () => {
        expect(classifyAddress("203.0.113.7")).toBe("public");
        expect(classifyAddress("2001:db8::1")).toBe("public");
    });
});

describe("resolveEgress", () => {
    it("refuses a member's private address, naming the way round it", async () => {
        await expect(resolveEgress("10.0.0.5", "member")).rejects.toThrow(
            /over SSH through a server of yours/
        );
    });

    it("lets whoever runs the instance reach its own network", async () => {
        await expect(resolveEgress("192.168.1.20", "instance")).resolves.toEqual({
            address: "192.168.1.20",
            name: "192.168.1.20"
        });
    });

    it("refuses the metadata service to everybody", async () => {
        await expect(resolveEgress("169.254.169.254", "instance")).rejects.toBeInstanceOf(
            EgressRefusal
        );
    });

    it("judges what a name resolves to, not the name", async () => {
        const lookup = answers({ postgres: ["172.18.0.4"], "db.example.com": ["203.0.113.9"] });
        await expect(resolveEgress("postgres", "member", lookup)).rejects.toThrow(
            /private network/
        );
        await expect(resolveEgress("db.example.com", "member", lookup)).resolves.toEqual({
            address: "203.0.113.9",
            name: "db.example.com"
        });
    });

    it("refuses a name with any internal answer among public ones", async () => {
        const lookup = answers({ "mixed.example.com": ["203.0.113.9", "127.0.0.1"] });
        await expect(resolveEgress("mixed.example.com", "member", lookup)).rejects.toThrow(
            /private network/
        );
    });

    it("says a name that resolves to nothing is not found", async () => {
        await expect(resolveEgress("nowhere.example.com", "member", answers({}))).rejects.toThrow(
            "Polaris could not find nowhere.example.com. Check the name."
        );
    });

    it("hands back the judged address, so the driver never asks DNS again", async () => {
        const lookup = answers({ "db.example.com": ["203.0.113.9"] });
        const resolved = await resolveEgress("db.example.com", "member", lookup);
        expect(resolved.address).toBe("203.0.113.9");
    });
});
