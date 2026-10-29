import { describe, expect, it } from "vitest";
import { POLARIS_TAG, readVpnSettings, vpnPolicy } from "@/lib/vpn/settings";

interface Grant {
    src: string[];
    dst: string[];
    ip: string[];
}

function parsed(admins: string[]) {
    return JSON.parse(vpnPolicy(admins)) as {
        groups: Record<string, string[]>;
        tagOwners: Record<string, string[]>;
        grants: Grant[];
    };
}

describe("the VPN's access policy", () => {
    it("keeps every user to their own devices, the Polaris servers and the exit nodes", () => {
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

    it("writes no empty group when there is no administrator", () => {
        const policy = parsed([]);
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
