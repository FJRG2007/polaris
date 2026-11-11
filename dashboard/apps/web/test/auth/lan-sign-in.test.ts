/**
 * Signing in on this machine's own LAN address: off until allowed, and then
 * only this machine's private addresses join the trusted origins.
 *
 * The CLI (`polaris lan-access on`) writes the same key straight to the
 * database, so the key and its "on" value are part of the contract.
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
    it("trusts no address while off", async () => {
        expect(await lan.lanSignInHosts()).toEqual([]);
        expect(await lan.lanSignInView()).toEqual({ enabled: false, addresses: ["192.168.1.172"] });
    });

    it("trusts this machine's private addresses once on", async () => {
        await lan.setLanSignIn(true);
        expect(await lan.lanSignInHosts()).toEqual(["192.168.1.172"]);
    });

    it("stores the key and value the CLI writes", async () => {
        await lan.setLanSignIn(true);
        expect(settings.get("auth.lanSignIn")).toBe("on");
        await lan.setLanSignIn(false);
        expect(settings.has("auth.lanSignIn")).toBe(false);
    });

    it("trusts nothing when the machine has reported no address", async () => {
        lanIps = [];
        await lan.setLanSignIn(true);
        expect(await lan.lanSignInHosts()).toEqual([]);
    });
});
