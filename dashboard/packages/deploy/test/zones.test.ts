/**
 * Zone hostname composition. Every URL Polaris hands out on a configured domain is
 * built here, so the cases that matter are the ones that silently produce a name no
 * DNS answers for: a base domain typed with a scheme or a wildcard, and the
 * empty-label zone that must resolve to the base domain rather than ".example.com".
 */

import { describe, expect, it } from "vitest";
import {
    defaultZones,
    isBaseDomain,
    isZoneLabel,
    normalizeBaseDomain,
    pickZone,
    randomZoneHostname,
    zoneHost,
    zoneHostname,
    zoneWildcard
} from "../src/zones.js";

describe("normalizeBaseDomain", () => {
    it("strips what an operator pastes around the domain", () => {
        expect(normalizeBaseDomain(" HTTPS://*.Example.com:8443/apps/ ")).toBe("example.com");
    });

    it("keeps a subdomain used as the base", () => {
        expect(normalizeBaseDomain("plr.example.com")).toBe("plr.example.com");
    });
});

describe("isBaseDomain", () => {
    it("accepts a registrable domain and a subdomain of one", () => {
        expect(isBaseDomain("plr.com")).toBe(true);
        expect(isBaseDomain("plr.polaris.com")).toBe(true);
    });

    it("rejects a bare label, a wildcard and an empty value", () => {
        expect(isBaseDomain("localhost")).toBe(false);
        expect(isBaseDomain("*.example.com")).toBe(false);
        expect(isBaseDomain("")).toBe(false);
    });
});

describe("isZoneLabel", () => {
    it("accepts one DNS label, and the empty label for the base domain", () => {
        expect(isZoneLabel("plr")).toBe(true);
        expect(isZoneLabel("")).toBe(true);
    });

    it("rejects a dotted or dash-edged label", () => {
        expect(isZoneLabel("a.b")).toBe(false);
        expect(isZoneLabel("-plr")).toBe(false);
    });
});

describe("zoneHost", () => {
    it("puts a labelled zone under the base domain", () => {
        expect(zoneHost({ label: "plr" }, "example.com")).toBe("plr.example.com");
    });

    it("uses the base domain itself for the empty label", () => {
        expect(zoneHost({ label: "" }, "example.com")).toBe("example.com");
    });

    it("normalizes the base it is given", () => {
        expect(zoneHost({ label: "polaris" }, "https://Example.com/")).toBe("polaris.example.com");
    });
});

describe("zoneWildcard", () => {
    it("is the one record a zone needs", () => {
        expect(zoneWildcard({ label: "plr" }, "example.com")).toBe("*.plr.example.com");
        expect(zoneWildcard({ label: "" }, "example.com")).toBe("*.example.com");
    });
});

describe("zoneHostname", () => {
    it("is stable for a name, so a redeploy keeps the URL", () => {
        const first = zoneHostname("invoices", { label: "plr" }, "example.com");
        expect(zoneHostname("invoices", { label: "plr" }, "example.com")).toBe(first);
        expect(first.endsWith(".plr.example.com")).toBe(true);
    });

    it("separates two services that slug the same", () => {
        expect(zoneHostname("My App", { label: "plr" }, "example.com")).not.toBe(
            zoneHostname("my-app!", { label: "plr" }, "example.com")
        );
    });
});

describe("randomZoneHostname", () => {
    it("never repeats a name", () => {
        const names = new Set(Array.from({ length: 50 }, () => randomZoneHostname({ label: "plr" }, "example.com")));
        expect(names.size).toBe(50);
    });
});

describe("pickZone", () => {
    const zones = [
        { label: "polaris", scope: "polaris" as const, primary: true },
        { label: "plr", scope: "deploy" as const, primary: true },
        { label: "apps", scope: "deploy" as const, primary: false }
    ];

    it("defaults to the primary zone of the scope", () => {
        expect(pickZone(zones, "deploy")?.label).toBe("plr");
    });

    it("honours an explicit label, including the base-domain zone", () => {
        expect(pickZone(zones, "deploy", "apps")?.label).toBe("apps");
        expect(pickZone(zones, "deploy", "nope")).toBeNull();
    });

    it("has nothing to offer for a scope with no zones", () => {
        expect(pickZone([], "deploy")).toBeNull();
    });
});

describe("defaultZones", () => {
    it("covers Polaris and deployed services, each with a primary", () => {
        const zones = defaultZones();
        expect(zones.filter((zone) => zone.scope === "polaris" && zone.primary)).toHaveLength(1);
        expect(zones.filter((zone) => zone.scope === "deploy" && zone.primary)).toHaveLength(1);
    });
});
