import { describe, expect, it } from "vitest";
import { decide, INITIAL_STATE, type FlipState } from "../../src/lib/backup-access/decision";
import * as inbound from "../../src/lib/backup-access/inbound";
import type { InboundEvidence, InboundReach } from "../../src/lib/backup-access/inbound";

// Fixture addresses. Public-looking on purpose: the documentation ranges are not
// public, so the publish rules would refuse them for the wrong reason.
const FIBRE = "88.0.0.10";
const STARLINK = "98.97.0.20";
const RELAY = "51.0.0.30";

const evidence = (over: Partial<InboundEvidence> = {}): InboundEvidence => ({
    ownIp: "192.168.1.10",
    routerWanIp: null,
    publicIp: FIBRE,
    ptr: [],
    outside: null,
    hairpin: false,
    stunIp: null,
    ...over
});

const reach = (over: Partial<InboundReach> = {}): InboundReach => ({
    checkedAt: "2026-10-27T10:00:00.000Z",
    publicIp: STARLINK,
    cgnat: true,
    certain: false,
    reason: "starlink",
    inboundProven: false,
    ipv6: null,
    ipv6Inbound: null,
    uplinkChangedAt: null,
    ...over
});

describe("detectCgnat", () => {
    it("reads a plain home line as reachable", () => {
        expect(inbound.detectCgnat(evidence()).cgnat).toBe(false);
    });

    it("is certain when the box itself holds a carrier address", () => {
        const verdict = inbound.detectCgnat(evidence({ ownIp: "100.72.1.5", outside: "up" }));
        expect(verdict).toMatchObject({ cgnat: true, certain: true, reason: "carrier-address" });
    });

    it("is certain when the router reports a carrier WAN address", () => {
        const verdict = inbound.detectCgnat(evidence({ routerWanIp: "100.100.0.1" }));
        expect(verdict).toMatchObject({ cgnat: true, certain: true, reason: "router-wan" });
    });

    it("is certain when the router's public WAN is not the address the internet sees", () => {
        const verdict = inbound.detectCgnat(evidence({ routerWanIp: RELAY, publicIp: FIBRE }));
        expect(verdict).toMatchObject({ cgnat: true, certain: true });
    });

    it("suspects a Starlink reverse name without proof of inbound", () => {
        const verdict = inbound.detectCgnat(
            evidence({ publicIp: STARLINK, ptr: ["customer.mdrdesp1.pop.starlinkisp.net"] })
        );
        expect(verdict).toMatchObject({ cgnat: true, certain: false, reason: "starlink" });
    });

    it("lets proof of inbound outweigh a Starlink name (a business public address)", () => {
        const verdict = inbound.detectCgnat(
            evidence({
                publicIp: STARLINK,
                ptr: ["customer.x.pop.starlinkisp.net."],
                outside: "up"
            })
        );
        expect(verdict.cgnat).toBe(false);
        expect(verdict.inboundProven).toBe(true);
    });

    it("does not let a hairpin outweigh an outside check that could not get in", () => {
        expect(inbound.detectCgnat(evidence({ outside: "down", hairpin: true }))).toMatchObject({
            cgnat: true,
            reason: "no-inbound",
            inboundProven: false
        });
    });

    it("does not let a hairpin outweigh a Starlink name", () => {
        const verdict = inbound.detectCgnat(
            evidence({ publicIp: STARLINK, ptr: ["customer.x.pop.starlinkisp.net"], hairpin: true })
        );
        expect(verdict).toMatchObject({ cgnat: true, reason: "starlink", inboundProven: false });
    });

    it("takes a hairpin as proof only when no outside check answered", () => {
        expect(inbound.detectCgnat(evidence({ hairpin: true }))).toMatchObject({
            cgnat: false,
            inboundProven: true
        });
    });

    it("treats an outside check that cannot get in as no inbound", () => {
        expect(inbound.detectCgnat(evidence({ outside: "down" }))).toMatchObject({
            cgnat: true,
            reason: "no-inbound"
        });
    });

    it("notes a STUN mapping that differs from the echo answer", () => {
        expect(inbound.detectCgnat(evidence({ stunIp: STARLINK })).reason).toBe("address-mismatch");
    });

    it("does not match a look-alike reverse name", () => {
        expect(inbound.detectCgnat(evidence({ ptr: ["host.notstarlinkisp.net"] })).cgnat).toBe(
            false
        );
    });
});

describe("actingEnvironment", () => {
    it("lets a detected carrier NAT win over a home-nat answer pinned months ago", () => {
        expect(inbound.actingEnvironment("home-nat", "home-cgnat", null)).toBe("home-cgnat");
        expect(
            inbound.actingEnvironment("home-nat", "home-nat", {
                cgnat: true,
                certain: true,
                reason: "router-wan"
            })
        ).toBe("home-cgnat");
        expect(
            inbound.actingEnvironment("home-nat", "home-nat", {
                cgnat: true,
                certain: false,
                reason: "starlink"
            })
        ).toBe("home-cgnat");
    });

    it("keeps a home-nat answer when only the outside check failed (a forward not set up yet)", () => {
        expect(
            inbound.actingEnvironment("home-nat", "home-nat", {
                cgnat: true,
                certain: false,
                reason: "no-inbound"
            })
        ).toBe("home-nat");
        expect(inbound.lineIsCgnat(reach({ reason: "no-inbound" }))).toBe(false);
        expect(inbound.lineIsCgnat(reach({ reason: "starlink" }))).toBe(true);
    });

    it("keeps the operator's answer otherwise", () => {
        expect(
            inbound.actingEnvironment("home-nat", "unknown", {
                cgnat: false,
                certain: false,
                reason: null
            })
        ).toBe("home-nat");
        expect(inbound.actingEnvironment(null, "vps", null)).toBe("vps");
        expect(inbound.actingEnvironment("vps", "home-cgnat", null)).toBe("vps");
    });
});

describe("mayPublish", () => {
    it("publishes a reachable public address", () => {
        expect(inbound.mayPublish({ ip: FIBRE, reach: null, backupServing: false }).publish).toBe(
            true
        );
    });

    it("refuses the address a carrier NAT shares", () => {
        expect(inbound.mayPublish({ ip: STARLINK, reach: reach(), backupServing: false })).toEqual({
            publish: false,
            refusal: "cgnat"
        });
    });

    it("refuses a carrier-space or private address outright", () => {
        expect(
            inbound.mayPublish({ ip: "100.64.3.3", reach: null, backupServing: false }).refusal
        ).toBe("not-public");
        expect(
            inbound.mayPublish({ ip: "10.0.0.1", reach: null, backupServing: false }).refusal
        ).toBe("not-public");
    });

    it("stands back while backup access owns the records", () => {
        expect(inbound.mayPublish({ ip: FIBRE, reach: null, backupServing: true }).refusal).toBe(
            "backup"
        );
    });

    it("does not carry a verdict about the Starlink address over to the fibre one", () => {
        expect(
            inbound.mayPublish({ ip: FIBRE, reach: reach(), backupServing: false }).publish
        ).toBe(true);
    });
});

describe("two-WAN failover", () => {
    const pass = (state: FlipState, ip: string, current: InboundReach | null, minute: number) => {
        const cg = inbound.cgnatVerdict(current, ip);
        return decide(state, {
            mode: "automatic",
            manualOn: false,
            pathReady: true,
            verdict: cg.down ? "down" : "up",
            failToFlip: cg.failToFlip,
            now: new Date(Date.parse("2026-10-27T10:00:00.000Z") + minute * 60_000)
        });
    };

    it("flips to the relay on the first pass when the fallback line is certainly CGNAT", () => {
        const certain = reach({ certain: true, reason: "router-wan" });
        const first = pass(INITIAL_STATE, STARLINK, certain, 0);
        expect(first.move).toBe("to-backup");
    });

    it("needs the usual streak for a suspected one, then returns with hysteresis", () => {
        let state = INITIAL_STATE;
        const moves: (string | null)[] = [];
        for (let minute = 0; minute < 3; minute += 1) {
            const next = pass(state, STARLINK, reach(), minute);
            moves.push(next.move);
            state = next.state;
        }
        expect(moves).toEqual([null, null, "to-backup"]);
        // The fibre comes back: a new address, about which the Starlink verdict says nothing.
        const back: (string | null)[] = [];
        for (let minute = 3; minute < 10; minute += 1) {
            const next = pass(state, FIBRE, reach(), minute);
            back.push(next.move);
            state = next.state;
        }
        expect(back.filter(Boolean)).toEqual(["to-direct"]);
        expect(back.indexOf("to-direct")).toBeGreaterThanOrEqual(4);
    });

    it("ignores a verdict about an address the line no longer has", () => {
        expect(inbound.cgnatVerdict(reach(), FIBRE).down).toBe(false);
        expect(inbound.cgnatVerdict(null, STARLINK).down).toBe(false);
    });
});

describe("call address", () => {
    it("advertises the relay while the relay serves", () => {
        const input = { serving: "backup", path: "relay", relayAddress: RELAY } as const;
        expect(inbound.callNodeIp(input)).toBe(RELAY);
        expect(inbound.callReach({ ...input, cgnat: true })).toBe("relay");
    });

    it("leaves STUN to decide on the direct path", () => {
        expect(
            inbound.callNodeIp({ serving: "direct", path: "relay", relayAddress: RELAY })
        ).toBeNull();
        expect(
            inbound.callReach({ cgnat: false, serving: "direct", path: null, relayAddress: null })
        ).toBe("direct");
    });

    it("says calls stay in the house behind a tunnel or a bare CGNAT line", () => {
        expect(
            inbound.callReach({
                cgnat: true,
                serving: "backup",
                path: "tunnel",
                relayAddress: null
            })
        ).toBe("local-only");
        expect(
            inbound.callReach({ cgnat: true, serving: "direct", path: null, relayAddress: null })
        ).toBe("local-only");
    });

    it("explains why outsiders cannot reach a call", () => {
        expect(
            inbound.callsOutside({ cgnat: true, serving: "direct", path: null, relayAddress: null })
        ).toBe("cgnat");
        expect(
            inbound.callsOutside({
                cgnat: false,
                serving: "backup",
                path: "tunnel",
                relayAddress: null
            })
        ).toBe("backup");
        expect(
            inbound.callsOutside({
                cgnat: true,
                serving: "backup",
                path: "relay",
                relayAddress: RELAY
            })
        ).toBeNull();
        expect(
            inbound.callsOutside({
                cgnat: false,
                serving: "direct",
                path: null,
                relayAddress: null
            })
        ).toBeNull();
    });

    it("never advertises a private relay address", () => {
        expect(
            inbound.callNodeIp({ serving: "backup", path: "relay", relayAddress: "10.1.2.3" })
        ).toBeNull();
    });
});

describe("paths", () => {
    it("recommends the direct line when it takes visitors, else the relay", () => {
        const base = { hasServer: true, cloudflare: true, tailscale: true };
        expect(inbound.recommendPath({ ...base, cgnat: false })).toBe("direct");
        expect(inbound.recommendPath({ ...base, cgnat: true })).toBe("relay");
        expect(inbound.recommendPath({ ...base, cgnat: true, hasServer: false })).toBe("tunnel");
        expect(
            inbound.recommendPath({
                cgnat: true,
                hasServer: false,
                cloudflare: false,
                tailscale: true
            })
        ).toBe("tailscale");
    });

    it("says what a tunnel cannot carry", () => {
        expect(inbound.carries("tunnel", "web")).toBe(true);
        expect(inbound.carries("tunnel", "calls")).toBe(false);
        expect(inbound.carries("tunnel", "games")).toBe(false);
        expect(inbound.carries("relay", "calls")).toBe(true);
        expect(inbound.carries("tailscale", "ownDomain")).toBe(false);
    });
});

describe("planAaaa", () => {
    it("publishes a global IPv6 address only once it took a connection from outside", () => {
        expect(inbound.planAaaa({ ipv6: "2001:db8::1", ipv6Inbound: true })).toBe("2001:db8::1");
        expect(inbound.planAaaa({ ipv6: "2001:db8::1", ipv6Inbound: null })).toBeNull();
        expect(inbound.planAaaa({ ipv6: "fd00::1", ipv6Inbound: true })).toBeNull();
        expect(inbound.planAaaa({ ipv6: "fe80::1", ipv6Inbound: true })).toBeNull();
        expect(inbound.isGlobalIpv6("192.0.2.1")).toBe(false);
    });
});

describe("readReach", () => {
    it("reads a stored verdict and rejects garbage", () => {
        expect(inbound.readReach(JSON.stringify(reach()))?.cgnat).toBe(true);
        expect(inbound.readReach("{")).toBeNull();
        expect(inbound.readReach(null)).toBeNull();
    });
});
