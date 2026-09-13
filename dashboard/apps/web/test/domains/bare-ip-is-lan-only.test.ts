/**
 * Who may reach the dashboard by typing an address instead of a name.
 *
 * The edge used to answer on any IPv4 literal, on the reasoning that a bare
 * address in the Host header means somebody already on this network. A forwarded
 * port makes that false: the sign-in page answered on the public address, so
 * anything walking the IPv4 space found a real login form with the control plane
 * behind it.
 *
 * So the IPv4 shape sits on its own router behind an allow list. The four things
 * worth pinning are all ways of getting this wrong quietly - a rule that still
 * matches everything, an allow list that forgets loopback, a middleware on the
 * entrypoint where it would stop certificate renewal instead, and the v2 spelling
 * of the middleware, which Traefik v3 ignores rather than refuses.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const COMPOSE = readFileSync(
    new URL("../../../../docker/docker-compose.yml", import.meta.url),
    "utf8"
);

/** The label values of one router or middleware, by their trailing key. */
function labels(prefix: string): Map<string, string> {
    const found = new Map<string, string>();
    for (const line of COMPOSE.split("\n")) {
        const match = /^\s*-\s*"([^"=]+)=(.*)"\s*$/.exec(line);
        if (!match || !match[1].startsWith(prefix)) continue;
        found.set(match[1].slice(prefix.length), match[2]);
    }
    return found;
}

const ipRouter = labels("traefik.http.routers.polaris-web-ip.");
const ipRouterHttp = labels("traefik.http.routers.polaris-web-ip-http.");
const named = labels("traefik.http.routers.polaris-web.");
const namedHttp = labels("traefik.http.routers.polaris-web-http.");

describe("the bare-address router", () => {
    it("is the only one matching an IPv4 literal", () => {
        expect(ipRouter.get("rule")).toContain("HostRegexp");
        expect(ipRouterHttp.get("rule")).toContain("HostRegexp");
        // The whole point of the split: leaving the shape on the named routers
        // would keep serving the public address however good the allow list is.
        expect(named.get("rule")).not.toContain("HostRegexp");
        expect(namedHttp.get("rule")).not.toContain("HostRegexp");
    });

    it("carries the allow list on both entrypoints", () => {
        expect(ipRouter.get("middlewares")).toBe("polaris-lan-only");
        expect(ipRouterHttp.get("middlewares")).toContain("polaris-lan-only");
        // :80 still redirects, or reaching the address by http would answer 403
        // where it used to answer a redirect somebody's browser follows.
        expect(ipRouterHttp.get("middlewares")).toContain("polaris-redirect-https");
    });

    it("serves the same thing the named router does, underneath everything else", () => {
        expect(ipRouter.get("service")).toBe("polaris-web");
        expect(ipRouterHttp.get("service")).toBe("polaris-web");
        expect(ipRouter.get("priority")).toBe("10");
        expect(ipRouterHttp.get("priority")).toBe("10");
    });

    it("leaves the named hosts open, which is what a domain is for", () => {
        expect(named.has("middlewares")).toBe(false);
        expect(namedHttp.get("middlewares")).toBe("polaris-redirect-https");
    });
});

describe("the allow list", () => {
    const ranges =
        labels("traefik.http.middlewares.polaris-lan-only.").get("ipallowlist.sourcerange") ?? "";

    it("uses the spelling Traefik v3 answers to", () => {
        // v2 called it `ipwhitelist`. v3 ignores an unknown middleware key rather
        // than refusing to start, so the wrong one is a router with no allow list
        // at all and nothing said about it.
        expect(COMPOSE).toContain("image: traefik:v3");
        expect(ranges).not.toBe("");
        expect(COMPOSE).not.toContain("polaris-lan-only.ipwhitelist");
    });

    it("keeps loopback, private networks and CGNAT", () => {
        // Loopback because the Windows installer opens https://127.0.0.1 when it
        // could not write a hosts entry, and CGNAT because that is where a
        // Tailscale address lands.
        for (const range of [
            "127.0.0.0/8",
            "10.0.0.0/8",
            "172.16.0.0/12",
            "192.168.0.0/16",
            "100.64.0.0/10"
        ]) {
            expect(ranges).toContain(range);
        }
        expect(ranges).toContain("::1/128");
    });

    it("is overridable, so a mistake is undone from the LAN it keeps reachable", () => {
        expect(ranges.startsWith("${POLARIS_IP_ACCESS_RANGES:-")).toBe(true);
    });

    it("is never put on an entrypoint, where it would stop certificate renewal", () => {
        // ACME answers its HTTP-01 challenge on `web` ahead of any router, so an
        // allow list there breaks renewal for the dashboard's domain and for
        // every deployed app - weeks later, silently.
        expect(COMPOSE).not.toMatch(/entrypoints\.web\.[^\n]*(ipallowlist|middlewares)/i);
    });
});
