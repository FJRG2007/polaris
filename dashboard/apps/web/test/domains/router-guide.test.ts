/**
 * The per-brand router instructions.
 *
 * The panel opens on whatever the router called itself, so a header that names a
 * brand has to reach that brand's page, and one that names nothing must land on the
 * generic instructions rather than on a wrong menu path - being confidently sent to
 * a menu that does not exist is worse than being told to go looking.
 */

import { describe, expect, it } from "vitest";
import { DEFAULT_PORT_BLOCKS } from "../../src/lib/apps/port-block";
import {
    detectRouterBrand,
    fitRuleNames,
    gameForwardRules,
    likelyGateway,
    mergeProtocolRules,
    routerGuide,
    ROUTER_BRANDS
} from "../../src/lib/router-guide";

describe("recognizing the router", () => {
    it("reads the brand out of the header the firmware sends", () => {
        // Verbatim from a ZTE HGU, which is what a Spanish fibre line usually ships.
        expect(detectRouterBrand("ZTE web server 1.0 ZTE corp 2015.")).toBe("zte");
        expect(detectRouterBrand("Huawei EchoLife")).toBe("huawei");
        expect(detectRouterBrand("Mikrotik HttpProxy")).toBe("mikrotik");
    });

    it("falls back to the generic instructions rather than guessing", () => {
        expect(detectRouterBrand(null)).toBe("other");
        expect(detectRouterBrand("nginx/1.24.0")).toBe("other");
    });
});

describe("the instructions themselves", () => {
    it("always resolves to a guide, whatever it is asked for", () => {
        for (const brand of ROUTER_BRANDS) {
            expect(routerGuide(brand.id).id).toBe(brand.id);
        }
    });

    it("warns that an ISP's ZTE reserves the two ports Polaris needs", () => {
        // The firmware refuses to forward 80 and 443 at all, so an operator following
        // the steps would otherwise fight a form that can never accept them.
        expect(routerGuide("zte").caution).toMatch(/80, 443/);
    });

    it("is written in English, whatever market the router ships in", () => {
        // The menus are read off the router's own page, which the operator can switch
        // to their language; a half-translated path matches neither.
        for (const brand of ROUTER_BRANDS) {
            expect(brand.forwardPath).not.toMatch(/Reenvio|Seguridad|puertos/i);
        }
    });
});

describe("giving the server a fixed address", () => {
    it("names a reservation path for every brand", () => {
        // "Reserve it in the DHCP settings" is not an instruction anyone can follow:
        // the tab is rarely the one called DHCP.
        for (const brand of ROUTER_BRANDS) {
            expect(brand.reserve.path.length).toBeGreaterThan(0);
        }
    });

    it("sends a ZTE to the binding tab, not the DHCP server tab", () => {
        const reserve = routerGuide("zte").reserve;

        expect(reserve.path).toBe("Local Network > LAN > DHCP Binding");
        expect(reserve.kind).toBe("form");
        if (reserve.kind !== "form") return;
        // The three fields that form asks for, and the button that commits them.
        expect(reserve.fields.map((field) => field.label)).toEqual(["Name", "MAC Address", "IP Address"]);
        expect(reserve.save).toBe("Create New Item");
    });

    it("asks for an address on every form-style brand, since that is the point", () => {
        for (const brand of ROUTER_BRANDS) {
            if (brand.reserve.kind !== "form") continue;
            expect(brand.reserve.fields.some((field) => field.value === "ip")).toBe(true);
            expect(brand.reserve.fields.some((field) => field.value === "mac")).toBe(true);
        }
    });
});

describe("the forwarding form", () => {
    it("uses ZTE's own labels, which match none of the generic ones", () => {
        const guide = routerGuide("zte");

        expect(guide.forwardFields?.map((field) => field.label)).toEqual([
            "Name",
            "Protocol",
            "WAN Host IP Address",
            "LAN Host",
            "WAN Port",
            "LAN Host Port"
        ]);
        // Both port fields are ranges on this firmware, and the WAN source has to be
        // left open or the rule only answers one address.
        expect(guide.forwardFields?.filter((field) => field.value === "portRange")).toHaveLength(2);
        expect(guide.forwardFields?.some((field) => field.value === "anySource")).toBe(true);
        expect(guide.forwardSave).toBe("Create New Item");
    });

    it("leaves the generic labels in place for brands that fit them", () => {
        expect(routerGuide("tplink").forwardFields).toBeNull();
        expect(routerGuide("other").forwardFields).toBeNull();
    });

    it("says a ZTE saves the rule switched off, and an unknown brand might", () => {
        // The rule is listed, every value in it is right, and no packet moves. There
        // is nothing on the page to work that out from, so it has to be said.
        expect(routerGuide("zte").forwardEnable).toMatch(/switched off/i);
        expect(routerGuide("other").forwardEnable).toMatch(/Enable or Status/i);
    });
});

describe("names the form will accept", () => {
    const ranged = [
        { name: "polaris-games-tcp", protocol: "TCP", port: 25565, endPort: 25664 },
        { name: "polaris-games-udp", protocol: "UDP", port: 19132, endPort: 19231 }
    ];

    it("shortens the range rules to ZTE's 16-character name field", () => {
        // 17 characters, and the form refuses the entry rather than trimming it: the
        // page would otherwise print a value that cannot be typed into the router.
        expect(routerGuide("zte").nameLimit).toBe(16);
        expect(fitRuleNames(ranged, routerGuide("zte").nameLimit).map((rule) => rule.name)).toEqual([
            "plr-games-tcp",
            "plr-games-udp"
        ]);
    });

    it("leaves every rule alone where the brand does not cap the name", () => {
        expect(fitRuleNames(ranged, null)).toBe(ranged);
        // Polaris's own two rules fit anywhere, so even a capped brand gets them
        // verbatim - a name nobody has to shorten should not be shortened.
        expect(
            fitRuleNames([{ name: "polaris-https", protocol: "TCP", port: 443 }], 16).map((rule) => rule.name)
        ).toEqual(["polaris-https"]);
    });

    it("keeps the port when it has to cut a per-port rule down", () => {
        // The tail is what says which server and which rule this is; the middle is
        // the part that can go.
        const [fitted] = fitRuleNames([{ name: "game-old-world-7777", protocol: "TCP", port: 7777 }], 16);

        expect(fitted?.name).toBe("game-old-wo-7777");
        expect(fitted?.name.length).toBeLessThanOrEqual(16);
    });

    it("never hands two rules the same name", () => {
        // A form that refuses a long name refuses a repeated one too, so trimming
        // must not turn two rules into one.
        const names = fitRuleNames(
            [
                { name: "game-alpha-one-25565", protocol: "TCP", port: 25565 },
                { name: "game-alpha-two-25566", protocol: "TCP", port: 25566 },
                { name: "game-alpha-six-25567", protocol: "TCP", port: 25567 }
            ],
            12
        ).map((rule) => rule.name);

        expect(new Set(names).size).toBe(3);
        for (const name of names) expect(name.length).toBeLessThanOrEqual(12);
    });
});

describe("the rules a game server needs", () => {
    const java = { name: "Survival", ports: [{ port: 25565, protocol: "tcp" as const }] };
    const crossplay = {
        name: "Creative",
        ports: [
            { port: 25566, protocol: "tcp" as const },
            { port: 19132, protocol: "udp" as const }
        ]
    };

    it("writes one rule per port, named after its server, when asked port by port", () => {
        // The name is what tells an operator a year later which rule belongs to
        // which server, and which one to delete with it.
        expect(gameForwardRules([java, crossplay], "per-port")).toEqual([
            { name: "game-survival-25565", protocol: "TCP", port: 25565 },
            { name: "game-creative-25566", protocol: "TCP", port: 25566 },
            { name: "game-creative-19132", protocol: "UDP", port: 19132 }
        ]);
    });

    it("collapses every server into one rule per transport under the range policy", () => {
        // The point of the range: this is the same two rules for two servers as for
        // twenty, and for the ones not created yet.
        expect(gameForwardRules([java, crossplay], "range")).toEqual([
            { name: "polaris-games-tcp", protocol: "TCP", port: 25565, endPort: 25664 },
            { name: "polaris-games-udp", protocol: "UDP", port: 19132, endPort: 19231 }
        ]);
    });

    it("opens no UDP range when nothing here answers on UDP", () => {
        // An opening with nothing behind it is still an opening.
        expect(gameForwardRules([java], "range")).toEqual([
            { name: "polaris-games-tcp", protocol: "TCP", port: 25565, endPort: 25664 }
        ]);
    });

    it("still names a server whose port the range does not reach", () => {
        // An install from before the block existed: forwarding the range would leave
        // it dark, and nothing else on the page would say why.
        const legacy = { name: "Old world", ports: [{ port: 7777, protocol: "tcp" as const }] };

        expect(gameForwardRules([java, legacy], "range", DEFAULT_PORT_BLOCKS)).toEqual([
            { name: "polaris-games-tcp", protocol: "TCP", port: 25565, endPort: 25664 },
            { name: "game-old-world-7777", protocol: "TCP", port: 7777 }
        ]);
    });

    it("follows a widened block rather than the default", () => {
        expect(gameForwardRules([java], "range", { tcp: { start: 30000, end: 30099 }, udp: DEFAULT_PORT_BLOCKS.udp })).toEqual([
            { name: "polaris-games-tcp", protocol: "TCP", port: 30000, endPort: 30099 },
            // 25565 is outside the widened block, so it keeps a rule of its own.
            { name: "game-survival-25565", protocol: "TCP", port: 25565 }
        ]);
    });
});

describe("finding the router's own address", () => {
    it("proposes the gateway from this server's address", () => {
        expect(likelyGateway("192.168.1.142")).toBe("192.168.1.1");
        expect(likelyGateway("10.0.5.7")).toBe("10.0.5.1");
    });

    it("proposes nothing when the address is unknown or malformed", () => {
        expect(likelyGateway(null)).toBeNull();
        expect(likelyGateway("not-an-ip")).toBeNull();
    });
});

describe("one rule where the router's form can hold two", () => {
    const calls = [
        { name: "polaris-calls-udp", protocol: "UDP", port: 7882 },
        { name: "polaris-calls-tcp", protocol: "TCP", port: 7881 }
    ];

    it("collapses the two call rules on a brand whose Protocol field does both", () => {
        expect(mergeProtocolRules(calls, "TCP And UDP")).toEqual([
            { name: "polaris-calls", protocol: "TCP And UDP", port: 7881, endPort: 7882 }
        ]);
    });

    it("leaves them alone on a brand that has no such option", () => {
        expect(mergeProtocolRules(calls, null)).toEqual(calls);
    });

    it("refuses a set with a gap in it, however both-capable the form is", () => {
        // 80 and 443 with a merged rule would open every port between them.
        const web = [
            { name: "polaris-http", protocol: "TCP", port: 80 },
            { name: "polaris-https", protocol: "UDP", port: 443 }
        ];
        expect(mergeProtocolRules(web, "TCP And UDP")).toEqual(web);
    });

    it("leaves a set that is already one transport", () => {
        const web = [
            { name: "polaris-http", protocol: "TCP", port: 80 },
            { name: "polaris-https", protocol: "TCP", port: 81 }
        ];
        expect(mergeProtocolRules(web, "TCP And UDP")).toEqual(web);
    });

    it("merges the same range published over both transports into one", () => {
        const games = [
            { name: "polaris-games-tcp", protocol: "TCP", port: 30000, endPort: 30010 },
            { name: "polaris-games-udp", protocol: "UDP", port: 30000, endPort: 30010 }
        ];
        expect(mergeProtocolRules(games, "TCP And UDP")).toEqual([
            { name: "polaris-games", protocol: "TCP And UDP", port: 30000, endPort: 30010 }
        ]);
    });

    it("keeps the first name when the rules share nothing worth calling a name", () => {
        const odd = [
            { name: "ab-tcp", protocol: "TCP", port: 500 },
            { name: "zz-udp", protocol: "UDP", port: 501 }
        ];
        expect(mergeProtocolRules(odd, "TCP And UDP")[0]?.name).toBe("ab-tcp");
    });

    it("gives ZTE the both-at-once label its form actually shows", () => {
        expect(ROUTER_BRANDS.find((brand) => brand.id === "zte")?.combinedProtocol).toBe("TCP And UDP");
    });
});
