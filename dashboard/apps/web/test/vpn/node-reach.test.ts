import { describe, expect, it } from "vitest";
import {
    blockedIsCertain,
    firewallPlace,
    nodeFirewallRule,
    nodeReach,
    REACH_STALE_MS
} from "@/lib/vpn/node-reach";

const NOW = new Date("2026-11-07T12:00:00Z");
const minutesAgo = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000);

describe("nodeReach", () => {
    it("says what a recent check found", () => {
        expect(nodeReach("open", minutesAgo(1), NOW)).toBe("reachable");
        expect(nodeReach("blocked", minutesAgo(1), NOW)).toBe("blocked");
    });

    it("reads a timestamp that crossed the wire as a string", () => {
        expect(nodeReach("blocked", minutesAgo(4).toISOString(), NOW)).toBe("blocked");
    });

    it("is not checked yet before any answer", () => {
        expect(nodeReach(null, null, NOW)).toBe("unchecked");
        expect(nodeReach(undefined, undefined, NOW)).toBe("unchecked");
        expect(nodeReach("open", null, NOW)).toBe("unchecked");
    });

    it("drops an answer too old to stand for now", () => {
        const stale = new Date(NOW.getTime() - REACH_STALE_MS - 1);
        expect(nodeReach("blocked", stale, NOW)).toBe("unchecked");
        expect(nodeReach("open", stale, NOW)).toBe("unchecked");
    });

    it("keeps a check that could not tell apart from one never made", () => {
        expect(nodeReach("unknown", minutesAgo(1), NOW)).toBe("unknown");
    });

    it("treats a value it does not know as unchecked", () => {
        expect(nodeReach("closed", minutesAgo(1), NOW)).toBe("unchecked");
    });
});

describe("firewallPlace", () => {
    it("sends a machine with a public address to its provider's firewall", () => {
        expect(firewallPlace("vpn-1", "194.164.169.157")).toBe("cloud");
    });

    it("sends a machine behind a router to a forward on it", () => {
        expect(firewallPlace("lirio-0", "192.168.1.20")).toBe("router");
        expect(firewallPlace("box", "10.0.0.5")).toBe("router");
    });

    it("trusts a server named after its provider over a private address", () => {
        expect(firewallPlace("ionos", "10.7.0.2")).toBe("cloud");
        expect(firewallPlace("Hetzner Falkenstein", "172.16.0.4")).toBe("cloud");
    });

    it("takes a name Polaris dials as a public machine", () => {
        expect(firewallPlace("vpn", "vpn.example.test")).toBe("cloud");
    });
});

describe("blockedIsCertain", () => {
    it("believes a blocked public machine", () => {
        expect(blockedIsCertain("194.164.169.157")).toBe(true);
    });

    it("doubts one knocked on through a router", () => {
        expect(blockedIsCertain("192.168.1.20")).toBe(false);
    });
});

describe("nodeFirewallRule", () => {
    it("is UDP to the node's own address and port", () => {
        expect(nodeFirewallRule("194.164.169.157", 51820)).toEqual({
            protocol: "UDP",
            port: 51820,
            destination: "194.164.169.157"
        });
    });
});
