import { describe, expect, it } from "vitest";
import { POLARIS_TAG, defaultZone, readVpnSettings, vpnPolicy } from "@/lib/vpn/settings";

describe("the zone a hostname lands in", () => {
    const base = { label: "base", host: "example.test", primary: false };
    const app = { label: "app", host: "app.example.test", primary: true };

    it("prefers the domain the primary zone sits under", () => {
        expect(defaultZone([app, base])).toBe("base");
    });

    it("keeps the primary zone when nothing sits above it", () => {
        expect(defaultZone([{ ...base, host: "other.test" }, app])).toBe("app");
    });

    it("takes the only zone there is, and none when there are none", () => {
        expect(defaultZone([base])).toBe("base");
        expect(defaultZone([])).toBeUndefined();
    });
});

interface Grant {
    src: string[];
    dst: string[];
    ip: string[];
}

function parsed(admins: string[], members: string[] | null = null) {
    return JSON.parse(vpnPolicy(admins, [], members)) as {
        groups: Record<string, string[]>;
        tagOwners: Record<string, string[]>;
        grants: Grant[];
    };
}

describe("the VPN's access policy", () => {
    it("keeps everybody, when the VPN is open to all, to their own devices, the servers and the exit nodes", () => {
        const { grants } = parsed([]);
        expect(grants).toEqual([
            { src: ["autogroup:member"], dst: ["autogroup:self"], ip: ["*"] },
            { src: ["autogroup:member"], dst: [POLARIS_TAG], ip: ["*"] },
            { src: ["autogroup:member"], dst: ["autogroup:internet"], ip: ["*"] }
        ]);
    });

    it("never lets an ordinary user reach everything", () => {
        const { grants } = parsed(["polaris-a"]);
        const open = grants.filter((grant) => grant.dst.includes("*"));
        expect(open).toEqual([{ src: ["group:admins"], dst: ["*"], ip: ["*"] }]);
    });

    it("names the administrators as Headscale users, once each and in a stable order", () => {
        const policy = parsed(["polaris-b", "polaris-a", "polaris-b"]);
        expect(policy.groups["group:admins"]).toEqual(["polaris-a@", "polaris-b@"]);
        expect(policy.tagOwners[POLARIS_TAG]).toEqual(["group:admins"]);
        expect(vpnPolicy(["polaris-a", "polaris-b"])).toBe(vpnPolicy(["polaris-b", "polaris-a"]));
    });

    it("lets in only the people the VPN was given to, and the administrators", () => {
        const { groups, grants } = parsed(["polaris-a"], ["polaris-c"]);
        expect(groups["group:vpn"]).toEqual(["polaris-a@", "polaris-c@"]);
        expect(grants.some((grant) => grant.src.includes("autogroup:member"))).toBe(false);
        expect(grants).toContainEqual({
            src: ["group:vpn"],
            dst: ["autogroup:internet"],
            ip: ["*"]
        });
    });

    it("gives somebody nobody granted it nothing at all - not even the exit nodes", () => {
        const { grants } = parsed([], []);
        expect(grants).toEqual([]);
        const policy = JSON.parse(vpnPolicy([], ["10.9.0.0/24"], []));
        expect(JSON.stringify(policy)).not.toContain("10.9.0.0/24");
    });

    it("is closed when nobody says it is open", () => {
        expect(vpnPolicy(["polaris-a"])).toBe(vpnPolicy(["polaris-a"], [], []));
    });

    it("writes no empty group when there is no administrator", () => {
        const policy = parsed([], []);
        expect(policy.groups).toEqual({});
        expect(policy.tagOwners[POLARIS_TAG]).toEqual([]);
    });
});

describe("the VPN's stored settings", () => {
    it("read a row from before Turn off kept the server as off", () => {
        expect(readVpnSettings({ hostname: "vpn.example.test", apiKey: "sealed" }).enabled).toBe(
            false
        );
    });

    it("keep enabled once written", () => {
        expect(readVpnSettings({ enabled: true }).enabled).toBe(true);
    });
});
