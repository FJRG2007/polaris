/**
 * Who gets into a game server, and what still has to be opened for them to reach
 * it at all.
 *
 * These are the two ways a server that looks perfectly healthy refuses everybody:
 * a list that is enforced and empty, and a port nothing ever forwarded. Both were
 * silent, so both are pinned down here - the matching in particular, because an
 * address rule that is too generous is a door left open and one that is too strict
 * locks the operator out of their own server.
 */

import { describe, expect, it } from "vitest";
import { parseJoinAddresses } from "@/lib/apps/minecraft/parse";
import { describePorts, gameReachAdvice } from "@/lib/apps/minecraft/reach-advice";
import {
    accessRefusal,
    addressesFor,
    addressMatches,
    isAddressRule,
    isPlayerName,
    joinAccess
} from "@/lib/apps/minecraft/access";

describe("addressMatches", () => {
    it("accepts the exact address it was given", () => {
        expect(addressMatches("203.0.113.9", "203.0.113.9")).toBe(true);
        expect(addressMatches("203.0.113.9", "203.0.113.10")).toBe(false);
    });

    it("accepts anything inside a range and nothing outside it", () => {
        expect(addressMatches("203.0.113.0/24", "203.0.113.200")).toBe(true);
        expect(addressMatches("203.0.113.0/24", "203.0.114.1")).toBe(false);
        // /32 is one address, and the shift that builds its mask is the one a
        // 32-wide shift would silently turn into a no-op.
        expect(addressMatches("203.0.113.9/32", "203.0.113.9")).toBe(true);
        expect(addressMatches("203.0.113.9/32", "203.0.113.8")).toBe(false);
    });

    it("lets a player whose line moves in from anywhere, when they asked for that", () => {
        expect(addressMatches("any", "203.0.113.9")).toBe(true);
        expect(addressMatches("0.0.0.0/0", "203.0.113.9")).toBe(true);
    });

    // The safe direction: the cost is a player being asked to register the address
    // they are on, where the other way round is a rule that lets everyone through.
    it("refuses an address or a rule it cannot read", () => {
        expect(addressMatches("203.0.113.9", "not-an-address")).toBe(false);
        expect(addressMatches("nonsense", "203.0.113.9")).toBe(false);
        expect(addressMatches("203.0.113.0/99", "203.0.113.9")).toBe(false);
    });
});

describe("isAddressRule", () => {
    it("takes an address, a range, or any", () => {
        expect(isAddressRule("203.0.113.9")).toBe(true);
        expect(isAddressRule("203.0.113.0/24")).toBe(true);
        expect(isAddressRule("ANY")).toBe(true);
    });

    it("rejects what a router would not recognize", () => {
        expect(isAddressRule("203.0.113")).toBe(false);
        expect(isAddressRule("299.0.113.9")).toBe(false);
        expect(isAddressRule("203.0.113.9/33")).toBe(false);
    });
});

describe("isPlayerName", () => {
    it("holds Java to what Mojang accepts", () => {
        expect(isPlayerName("java", "Steve_01")).toBe(true);
        expect(isPlayerName("java", "ab")).toBe(false);
        expect(isPlayerName("java", "has space")).toBe(false);
    });

    it("lets a gamertag have its spaces", () => {
        expect(isPlayerName("bedrock", "Some Gamer")).toBe(true);
        expect(isPlayerName("bedrock", "")).toBe(false);
    });
});

describe("accessRefusal", () => {
    const allowed = [{ username: "Steve", address: "203.0.113.9" }];

    it("lets in a registered player from their own address", () => {
        expect(accessRefusal("Steve", "203.0.113.9", allowed)).toBeNull();
    });

    it("names the reason rather than refusing anonymously", () => {
        expect(accessRefusal("Mallory", "203.0.113.9", allowed)).toContain("player list");
        expect(accessRefusal("Steve", "198.51.100.4", allowed)).toContain("different network");
    });

    // A join line that has scrolled out of the log is not evidence against the
    // player, so they are judged on their name alone.
    it("does not refuse a player whose address is unknown", () => {
        expect(accessRefusal("Steve", null, allowed)).toBeNull();
    });

    it("matches the name however it was capitalized", () => {
        expect(accessRefusal("steve", "203.0.113.9", allowed)).toBeNull();
    });

    // One person plays from more than one place. Reading only the first rule
    // written for a name is what made a second address impossible: the same
    // player on their laptop was refused by the rule written for their desk.
    it("lets a player in from any address they are registered to", () => {
        const both = [
            { username: "Steve", address: "203.0.113.9" },
            { username: "Steve", address: "198.51.100.0/24" }
        ];
        expect(accessRefusal("Steve", "203.0.113.9", both)).toBeNull();
        expect(accessRefusal("Steve", "198.51.100.4", both)).toBeNull();
        expect(accessRefusal("Steve", "192.0.2.7", both)).toContain("different network");
    });

    it("gathers every address one player holds", () => {
        const both = [
            { username: "Steve", address: "203.0.113.9" },
            { username: "Alex", address: "any" },
            { username: "steve", address: "198.51.100.0/24" }
        ];
        expect(addressesFor("STEVE", both)).toEqual(["203.0.113.9", "198.51.100.0/24"]);
        expect(addressesFor("Nobody", both)).toEqual([]);
    });
});

describe("joinAccess", () => {
    // The defect this exists for: both images enforce a list and start with it
    // empty, which is a server that refuses its own owner.
    it("puts the creator on the Java whitelist and makes them an operator", () => {
        const access = joinAccess("java", "Steve");
        expect(access.env.WHITELIST).toBe("Steve");
        expect(access.env.OPS).toBe("Steve");
        expect(access.env.ENABLE_WHITELIST).toBeUndefined();
    });

    // Bedrock's allow list wants an XUID nobody has yet, so it cannot be the thing
    // that closes the server - and leaving it on would close it to everybody.
    it("does not leave a Bedrock server behind an allow list it cannot fill", () => {
        const access = joinAccess("bedrock", "Some Gamer");
        expect(access.env.ALLOW_LIST).toBe("false");
        expect(access.env.OPS).toBe("Some Gamer");
    });
});

describe("parseJoinAddresses", () => {
    const log = [
        "[00:40:14 INFO]: Starting minecraft server version 26.2",
        "[00:41:02 INFO]: Steve[/203.0.113.9:52344] logged in with entity id 214 at (1.5, 64.0, 2.5)",
        "[00:42:11 INFO]: Alice[/198.51.100.4:41022] logged in with entity id 300 at (0.5, 70.0, 0.5)"
    ].join("\n");

    it("reads the address each player joined from", () => {
        const found = parseJoinAddresses(log);
        expect(found.get("steve")).toBe("203.0.113.9");
        expect(found.get("alice")).toBe("198.51.100.4");
    });

    // A player who reconnects is at the new address; the first line is where they
    // were an hour ago.
    it("keeps the newest join for a player", () => {
        const rejoined = `${log}\n[00:50:00 INFO]: Steve[/198.51.100.9:52999] logged in with entity id 400 at (1.5, 64.0, 2.5)`;
        expect(parseJoinAddresses(rejoined).get("steve")).toBe("198.51.100.9");
    });

    it("finds nothing in a log that carries no joins", () => {
        expect(parseJoinAddresses("[00:40:14 INFO]: Done (9.643s)!").size).toBe(0);
    });
});

describe("gameReachAdvice", () => {
    const ports = [{ port: 25565, protocol: "tcp" as const }];

    it("says nothing more is needed once somebody has joined from outside", () => {
        expect(gameReachAdvice("home-nat", ports, true).ok).toBe(true);
    });

    // The failure the whole thing exists for: DNS right, server up, port never
    // forwarded, and nothing anywhere saying so.
    it("asks for the forward on a home line, naming the port and the machine", () => {
        const advice = gameReachAdvice("home-nat", ports, false, "192.168.1.142");
        expect(advice.ok).toBe(false);
        expect(advice.forward).toBe(true);
        expect(advice.title).toContain("TCP 25565");
        expect(advice.steps.join(" ")).toContain("192.168.1.142");
    });

    it("asks for a firewall rule rather than a forward in a data centre", () => {
        const advice = gameReachAdvice("vps", ports, false);
        expect(advice.forward).toBe(false);
        expect(advice.steps.join(" ")).toContain("firewall");
    });

    // No forward can help on a shared address, so offering the router steps would
    // send the operator somewhere with nothing to give them.
    it("does not offer a forward that cannot exist on carrier NAT", () => {
        const advice = gameReachAdvice("home-cgnat", ports, false);
        expect(advice.forward).toBe(false);
        expect(advice.actionable).toBe(true);
    });

    it("has nothing to ask for when no port is published", () => {
        expect(gameReachAdvice("home-nat", [], false).ok).toBe(true);
    });

    // Under the range policy the operator is not being asked to open this server's
    // port; they are being asked to open the block it came out of, once.
    it("asks for the range rather than the port when that is what covers it", () => {
        const advice = gameReachAdvice("home-nat", ports, false, "192.168.1.142", "range");
        const steps = advice.steps.join(" ");

        expect(steps).toContain("TCP 25565-25664");
        expect(steps).toContain("192.168.1.142");
        expect(steps).toContain("last time");
    });

    it("names only the transports in play when it asks for the ranges", () => {
        const both = [
            { port: 25565, protocol: "tcp" as const },
            { port: 19132, protocol: "udp" as const }
        ];

        expect(gameReachAdvice("home-nat", both, false, null, "range").steps[0]).toContain(
            "TCP 25565-25664 and UDP 19132-19231"
        );
        expect(gameReachAdvice("home-nat", ports, false, null, "range").steps[0]).not.toContain("UDP");
    });
});

describe("describePorts", () => {
    it("names both transports, because forwarding one as the other forwards nothing", () => {
        expect(
            describePorts([
                { port: 25565, protocol: "tcp" },
                { port: 19132, protocol: "udp" }
            ])
        ).toBe("TCP 25565 and UDP 19132");
    });
});
