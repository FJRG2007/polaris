/**
 * The subdomain an app asks the operator's OpenTunnel server for. It is derived,
 * not stored, so it has to be stable across restarts (the published URL must not
 * move) and unique per app (two services with the same name would otherwise fight
 * over one hostname on the tunnel server).
 */

import { describe, expect, it } from "vitest";
import { openTunnelHostname, openTunnelSubdomain } from "../../src/lib/deploy/opentunnel-naming";

const APP = "019f8506-683f-7dd0-9c13-1e9ee9237fe3";
const OTHER = "019f8506-683f-7dd0-9c13-1e9ee9237fe4";

describe("openTunnelSubdomain", () => {
    it("is stable for an app, so the published URL survives a restart", () => {
        expect(openTunnelSubdomain(APP, "Invoices")).toBe(openTunnelSubdomain(APP, "Invoices"));
    });

    it("separates two apps that share a name", () => {
        expect(openTunnelSubdomain(APP, "Invoices")).not.toBe(openTunnelSubdomain(OTHER, "Invoices"));
    });

    it("is a usable DNS label", () => {
        expect(openTunnelSubdomain(APP, "My App!")).toMatch(/^[a-z0-9][a-z0-9-]{0,62}$/);
    });

    it("still yields a label for a name with nothing DNS-safe in it", () => {
        expect(openTunnelSubdomain(APP, "***")).toMatch(/^app-[a-f0-9]{6}$/);
    });
});

describe("openTunnelHostname", () => {
    it("sits under the server's base path", () => {
        expect(openTunnelHostname("invoices-abc123", { domain: "example.com", basePath: "op", insecure: false })).toBe(
            "invoices-abc123.op.example.com"
        );
    });

    it("sits on the domain itself when the server publishes with no base path", () => {
        expect(openTunnelHostname("invoices-abc123", { domain: "example.com", basePath: "", insecure: false })).toBe(
            "invoices-abc123.example.com"
        );
    });
});
