import { describe, expect, it } from "vitest";
import {
    CLOUD_FIREWALLS,
    detectCloud,
    relayFirewallRules,
    rulePort,
    ruleState
} from "@/lib/backup-access/firewall-guide";
import enAdmin from "../../messages/en-US/admin.json";
import esAdmin from "../../messages/es-ES/admin.json";

describe("relayFirewallRules", () => {
    const rules = relayFirewallRules(52000, [443, 80, 7881, 25565], [7882, 19135, 19133, 19134]);

    it("leads with the link, then TCP and UDP", () => {
        expect(rules[0]).toEqual({
            protocol: "UDP",
            port: 52000,
            endPort: 52000,
            purpose: "link"
        });
        expect(rules.map((rule) => `${rule.protocol} ${rulePort(rule)}`)).toEqual([
            "UDP 52000",
            "TCP 80",
            "TCP 443",
            "TCP 7881",
            "TCP 25565",
            "UDP 7882",
            "UDP 19133-19135"
        ]);
    });

    it("names what each rule is for", () => {
        expect(rules.map((rule) => rule.purpose)).toEqual([
            "link",
            "web",
            "web",
            "calls",
            "games",
            "calls",
            "games"
        ]);
    });

    it("keeps neighbouring ports apart when they serve different things", () => {
        const split = relayFirewallRules(52000, [7881, 7882], []);
        expect(split.slice(1).map(rulePort)).toEqual(["7881", "7882"]);
    });
});

describe("ruleState", () => {
    const [link, tcp, udp] = [
        { protocol: "UDP", port: 52000, endPort: 52000, purpose: "link" },
        { protocol: "TCP", port: 25565, endPort: 25569, purpose: "games" },
        { protocol: "UDP", port: 19133, endPort: 19135, purpose: "games" }
    ] as const;

    it("reads the link from the link", () => {
        expect(ruleState(link, true, null)).toBe("open");
        expect(ruleState(link, false, [])).toBe("closed");
    });

    it("blocks a range when any port in it is shut", () => {
        expect(ruleState(tcp, true, [25567])).toBe("closed");
        expect(ruleState(tcp, true, [443])).toBe("open");
    });

    it("never claims what it could not look at", () => {
        expect(ruleState(tcp, true, null)).toBe("unknown");
        expect(ruleState(udp, true, [])).toBe("unknown");
    });
});

describe("detectCloud", () => {
    it("takes the provider from the server's name, and stays generic otherwise", () => {
        expect(detectCloud("IONOS-madrid")).toBe("ionos");
        expect(detectCloud("ubuntu")).toBe("other");
        expect(detectCloud(null)).toBe("other");
    });
});

describe("the steps", () => {
    it("exist in every language for every step a provider declares", () => {
        for (const catalog of [enAdmin, esAdmin]) {
            const clouds = catalog.domains.backup.firewall.clouds as Record<
                string,
                Record<string, string>
            >;
            for (const cloud of CLOUD_FIREWALLS)
                expect(Object.keys(clouds[cloud.id] ?? {})).toHaveLength(cloud.steps);
        }
    });
});
