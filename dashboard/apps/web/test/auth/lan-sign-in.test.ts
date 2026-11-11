/**
 * Signing in on this machine's own LAN address: allowed unless turned off, and
 * only this machine's private addresses join the trusted origins.
 *
 * The CLI (`polaris lan-access on|off`) writes the same key straight to the
 * database, so the key and its "on"/"off" values are part of the contract.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const settings = new Map<string, string>();
let lanIps: string[] = ["192.168.1.172"];

vi.mock("@/lib/setting-store", () => ({
    getSetting: async (key: string) => settings.get(key) ?? null,
    setSetting: async (key: string, value: string | null) => {
        if (value === null) settings.delete(key);
        else settings.set(key, value);
    }
}));
vi.mock("@/lib/host-address", () => ({ getHostLanIps: async () => lanIps }));

const lan = await import("@/lib/lan-sign-in");

beforeEach(() => {
    settings.clear();
    lanIps = ["192.168.1.172"];
});

describe("sign-in by local IP", () => {
    it("trusts this machine's private addresses on an install that never chose", async () => {
        expect(await lan.lanSignInHosts()).toEqual(["192.168.1.172"]);
        expect(await lan.lanSignInView()).toEqual({ enabled: true, addresses: ["192.168.1.172"] });
    });

    it("keeps trusting them where an earlier version stored \"on\"", async () => {
        settings.set("auth.lanSignIn", "on");
        expect(await lan.lanSignInHosts()).toEqual(["192.168.1.172"]);
    });

    it("trusts no address once turned off", async () => {
        await lan.setLanSignIn(false);
        expect(await lan.lanSignInHosts()).toEqual([]);
        expect((await lan.lanSignInView()).enabled).toBe(false);
    });

    it("stores the key and values the CLI writes", async () => {
        await lan.setLanSignIn(false);
        expect(settings.get("auth.lanSignIn")).toBe("off");
        await lan.setLanSignIn(true);
        expect(settings.get("auth.lanSignIn")).toBe("on");
    });

    it("trusts the private address a request reached, on an install that never learned its own", async () => {
        lanIps = [];
        const request = new Request("http://internal/api/auth/sign-in/email", {
            headers: { host: "192.168.1.172" }
        });
        expect(await lan.lanSignInHosts(request)).toEqual(["192.168.1.172"]);
        const withPort = new Request("http://internal/", { headers: { host: "10.0.0.5:8443" } });
        expect(await lan.lanSignInHosts(withPort)).toEqual(["10.0.0.5:8443"]);
    });

    it("never trusts a name or a public address from the request", () => {
        for (const host of ["evil.example.com", "8.8.8.8", "192.168.1.172.evil.com", "192.168.1.300", "10.0.0.5:99999"]) {
            expect(lan.requestLanHost(new Request("http://internal/", { headers: { host } }))).toBeNull();
        }
        expect(lan.requestLanHost(undefined)).toBeNull();
    });

    it("trusts no address from the request once turned off", async () => {
        await lan.setLanSignIn(false);
        const request = new Request("http://internal/", { headers: { host: "192.168.1.172" } });
        expect(await lan.lanSignInHosts(request)).toEqual([]);
    });

    it("trusts nothing when the machine has reported no address", async () => {
        lanIps = [];
        expect(await lan.lanSignInHosts()).toEqual([]);
    });
});
