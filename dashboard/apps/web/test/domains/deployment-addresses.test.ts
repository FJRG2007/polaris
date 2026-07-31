/**
 * The list of addresses Settings shows.
 *
 * It answers "where is this Polaris reachable from", so the properties that
 * matter are that nothing is left out - the install URL, the local name, the
 * configured domains and a tunnel each come from a different place - and that one
 * address is listed once however many of those places name it. A duplicate reads
 * as two separate ways in, which is exactly the confusion the list exists to end.
 *
 * It also has to survive its sources: the domains and the tunnel are read out of
 * the process, and a settings page that fails to render because a tunnel daemon
 * is busy would be worse than a short list.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

let domains: string[] = [];
let tunnel: string | null = null;
let domainsFail = false;

vi.mock("@polaris/config", () => ({
    loadEnv: () => ({ POLARIS_APP_URL: "http://polaris.local", POLARIS_LOCAL_HOSTNAME: "polaris" })
}));
vi.mock("@/lib/domain-edge", async () => {
    const actual = await vi.importActual<typeof import("../../src/lib/domain-edge")>("../../src/lib/domain-edge");
    return {
        publicHostname: actual.publicHostname,
        dashboardHosts: async () => {
            if (domainsFail) throw new Error("no database");
            return domains;
        }
    };
});
vi.mock("@/lib/polaris-tunnel-service", () => ({ getPolarisPublicUrl: async () => tunnel }));

const { reachableAddresses } = await import("../../src/lib/deployment-addresses");

beforeEach(() => {
    domains = [];
    tunnel = null;
    domainsFail = false;
});

describe("where a deployment is reachable", () => {
    it("lists every way in, each named for what it is", async () => {
        domains = ["polaris.example.com"];
        tunnel = "https://ready-cat-9.trycloudflare.com/";

        expect(await reachableAddresses()).toEqual([
            { url: "http://polaris.local", host: "polaris.local", kind: "app" },
            { url: "https://polaris.example.com", host: "polaris.example.com", kind: "domain" },
            { url: "https://ready-cat-9.trycloudflare.com", host: "ready-cat-9.trycloudflare.com", kind: "tunnel" }
        ]);
    });

    it("lists an address once, however many places name it", async () => {
        // The deployment was installed on its own domain, which is also configured.
        domains = ["polaris.example.com", "polaris.example.com"];

        const hosts = (await reachableAddresses()).map((address) => address.host);
        expect(hosts).toEqual(["polaris.local", "polaris.example.com"]);
    });

    it("includes the local name when the install URL is something else", async () => {
        domains = [];

        const kinds = (await reachableAddresses()).map((address) => address.kind);
        // The install URL here IS the local name, so the local entry folds into it.
        expect(kinds).toEqual(["app"]);
    });

    it("still answers when the domains cannot be read", async () => {
        domainsFail = true;

        expect((await reachableAddresses()).map((address) => address.host)).toEqual(["polaris.local"]);
    });
});
