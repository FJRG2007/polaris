import { describe, expect, it } from "vitest";
import { isCarrierGradeNat, isIpv4, isPrivateIp, isPublicIpv4 } from "../src/cidr.js";
import { environmentFromAddress, serverEnvironmentGroup } from "../src/schemas/host.js";

describe("isPrivateIp", () => {
    it("treats RFC1918, loopback, link-local and CGNAT space as private", () => {
        for (const ip of ["10.0.0.5", "172.16.4.1", "192.168.1.138", "127.0.0.1", "169.254.10.1", "100.100.1.1"]) {
            expect(isPrivateIp(ip)).toBe(true);
        }
    });

    it("treats a routable address as public", () => {
        expect(isPrivateIp("1.1.1.1")).toBe(false);
        expect(isPrivateIp("172.32.0.1")).toBe(false);
        expect(isPrivateIp("2606:4700::1111")).toBe(false);
    });

    it("treats anything unparseable as private, so it is never called reachable", () => {
        expect(isPrivateIp("nas.local")).toBe(true);
        expect(isPrivateIp("")).toBe(true);
    });

    it("classifies an IPv4-mapped IPv6 address by its IPv4 form", () => {
        expect(isPrivateIp("::ffff:8.8.8.8")).toBe(false);
        expect(isPrivateIp("::ffff:192.168.1.10")).toBe(true);
    });
});

describe("isIpv4 / isPublicIpv4", () => {
    it("accepts IPv4 literals and the IPv4-mapped form", () => {
        expect(isIpv4("192.168.1.10")).toBe(true);
        expect(isIpv4("::ffff:8.8.8.8")).toBe(true);
    });

    it("rejects IPv6 and hostnames, which cannot back a magic subdomain", () => {
        expect(isIpv4("2606:4700::1111")).toBe(false);
        expect(isIpv4("nas.local")).toBe(false);
        expect(isIpv4("")).toBe(false);
    });

    it("calls only a routable IPv4 publicly usable", () => {
        expect(isPublicIpv4("8.8.8.8")).toBe(true);
        expect(isPublicIpv4("192.168.1.10")).toBe(false);
        // Routable, but its colons cannot survive into a DNS label.
        expect(isPublicIpv4("2606:4700::1111")).toBe(false);
    });
});

describe("isCarrierGradeNat", () => {
    it("matches only 100.64.0.0/10", () => {
        expect(isCarrierGradeNat("100.64.0.1")).toBe(true);
        expect(isCarrierGradeNat("100.127.255.254")).toBe(true);
        expect(isCarrierGradeNat("100.128.0.1")).toBe(false);
        expect(isCarrierGradeNat("192.168.1.1")).toBe(false);
        expect(isCarrierGradeNat("nas.local")).toBe(false);
        expect(isCarrierGradeNat("::ffff:100.70.3.4")).toBe(true);
    });
});

describe("environmentFromAddress", () => {
    it("reads a private address as a home/office LAN server", () => {
        expect(environmentFromAddress("192.168.1.10")).toBe("home-nat");
        expect(environmentFromAddress(" 10.8.0.4 ")).toBe("home-nat");
    });

    it("reads carrier-NAT space as a home line with no inbound ports", () => {
        expect(environmentFromAddress("100.70.3.4")).toBe("home-cgnat");
    });

    it("reads a public address as a server holding its own IP", () => {
        expect(environmentFromAddress("51.15.20.30")).toBe("vps");
    });

    it("does not call a reserved or documentation address a public server", () => {
        expect(environmentFromAddress("203.0.113.7")).toBe("home-nat");
    });

    it("stays unknown for a hostname, which says nothing about the network", () => {
        expect(environmentFromAddress("db.example.com")).toBe("unknown");
        expect(environmentFromAddress("")).toBe("unknown");
    });
});

describe("serverEnvironmentGroup", () => {
    it("groups the environments by how traffic reaches them", () => {
        expect(serverEnvironmentGroup("home-nat")).toBe("home");
        expect(serverEnvironmentGroup("home-cgnat")).toBe("home");
        expect(serverEnvironmentGroup("vps")).toBe("datacenter");
        expect(serverEnvironmentGroup("cloud")).toBe("datacenter");
        expect(serverEnvironmentGroup("unknown")).toBe("unknown");
    });
});
