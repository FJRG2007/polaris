import { describe, expect, it } from "vitest";
import {
    CLOUD_FIREWALLS,
    detectCloud,
    linkState,
    relayFirewallRules,
    ruleState
} from "@/lib/backup-access/firewall-guide";
import { portText } from "@/app/(app)/admin/domains/guide-parts";
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
        expect(rules.map((rule) => `${rule.protocol} ${portText(rule)}`)).toEqual([
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

    it("tells the tunnels that end here from games", () => {
        const carried = relayFirewallRules(52000, [], [19132, 51820, 51821, 51999]);
        expect(carried.slice(1).map((rule) => [portText(rule), rule.purpose])).toEqual([
            ["19132", "games"],
            ["51820-51821", "tunnels"],
            ["51999", "tunnels"]
        ]);
    });

    it("keeps neighbouring ports apart when they serve different things", () => {
        const split = relayFirewallRules(52000, [7881, 7882], []);
        expect(split.slice(1).map(portText)).toEqual(["7881", "7882"]);
    });
});

describe("ruleState", () => {
    const [link, tcp, udp] = [
        { protocol: "UDP", port: 52000, endPort: 52000, purpose: "link" },
        { protocol: "TCP", port: 25565, endPort: 25569, purpose: "games" },
        { protocol: "UDP", port: 19133, endPort: 19135, purpose: "games" }
    ] as const;

    it("gives the link the state it was found in", () => {
        expect(ruleState(link, "open", null, [])).toBe("open");
        expect(ruleState(link, "closed", [], [])).toBe("closed");
        expect(ruleState(link, "unknown", [], [])).toBe("unknown");
    });

    it("blocks a range when any port in it is shut", () => {
        expect(ruleState(tcp, "open", [25567], [])).toBe("closed");
        expect(ruleState(tcp, "open", [443], [])).toBe("open");
    });

    it("does not blame the firewall for a port that refused", () => {
        expect(ruleState(tcp, "open", [], [25567])).toBe("unknown");
        expect(ruleState(tcp, "open", [25566], [25567])).toBe("closed");
    });

    it("never claims what it could not look at", () => {
        expect(ruleState(tcp, "open", null, [])).toBe("unknown");
        expect(ruleState(udp, "open", [], [])).toBe("unknown");
    });
});

describe("linkState", () => {
    const probe = {
        latency: { relay: null },
        problem: "relay-unreachable",
        relayClosed: [],
        relayUnclear: []
    };

    it("is open once a visitor gets through", () => {
        expect(linkState({ ...probe, problem: null, latency: { relay: 40 } })).toBe("open");
    });

    it("is shut only when the relay answers and visitors still do not get through", () => {
        expect(linkState(probe)).toBe("closed");
    });

    it("says nothing when the relay's silence has another explanation", () => {
        expect(linkState(null)).toBe("unknown");
        expect(linkState({ ...probe, problem: null })).toBe("unknown");
        expect(linkState({ ...probe, problem: "setting-up" })).toBe("unknown");
        expect(linkState({ ...probe, relayClosed: null })).toBe("unknown");
        expect(linkState({ ...probe, relayClosed: [443] })).toBe("unknown");
        expect(linkState({ ...probe, relayUnclear: [443] })).toBe("unknown");
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
