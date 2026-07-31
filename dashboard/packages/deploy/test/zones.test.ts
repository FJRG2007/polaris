/**
 * Zone hostname composition. Every URL Polaris hands out on a configured domain is
 * built here, so the cases that matter are the ones that silently produce a name no
 * DNS answers for: a base domain typed with a scheme or a wildcard, and the
 * empty-label zone that must resolve to the base domain rather than ".example.com".
 */

import { describe, expect, it } from "vitest";
import * as domainZones from "../src/zones.js";

describe("normalizeBaseDomain", () => {
    it("strips what an operator pastes around the domain", () => {
        expect(domainZones.normalizeBaseDomain(" HTTPS://*.Example.com:8443/apps/ ")).toBe("example.com");
    });

    it("keeps a subdomain used as the base", () => {
        expect(domainZones.normalizeBaseDomain("plr.example.com")).toBe("plr.example.com");
    });
});

describe("isBaseDomain", () => {
    it("accepts a registrable domain and a subdomain of one", () => {
        expect(domainZones.isBaseDomain("plr.com")).toBe(true);
        expect(domainZones.isBaseDomain("plr.polaris.com")).toBe(true);
    });

    it("rejects a bare label, a wildcard and an empty value", () => {
        expect(domainZones.isBaseDomain("localhost")).toBe(false);
        expect(domainZones.isBaseDomain("*.example.com")).toBe(false);
        expect(domainZones.isBaseDomain("")).toBe(false);
    });
});

describe("isZoneLabel", () => {
    it("accepts one DNS label, and the empty label for the base domain", () => {
        expect(domainZones.isZoneLabel("plr")).toBe(true);
        expect(domainZones.isZoneLabel("")).toBe(true);
    });

    it("rejects a dotted or dash-edged label", () => {
        expect(domainZones.isZoneLabel("a.b")).toBe(false);
        expect(domainZones.isZoneLabel("-plr")).toBe(false);
    });
});

describe("zoneHost", () => {
    it("puts a labelled zone under the base domain", () => {
        expect(domainZones.zoneHost({ label: "plr" }, "example.com")).toBe("plr.example.com");
    });

    it("uses the base domain itself for the empty label", () => {
        expect(domainZones.zoneHost({ label: "" }, "example.com")).toBe("example.com");
    });

    it("normalizes the base it is given", () => {
        expect(domainZones.zoneHost({ label: "polaris" }, "https://Example.com/")).toBe("polaris.example.com");
    });
});

describe("zoneWildcard", () => {
    it("is the one record a zone needs", () => {
        expect(domainZones.zoneWildcard({ label: "plr" }, "example.com")).toBe("*.plr.example.com");
        expect(domainZones.zoneWildcard({ label: "" }, "example.com")).toBe("*.example.com");
    });
});

describe("zoneHostname", () => {
    it("is stable for a name, so a redeploy keeps the URL", () => {
        const first = domainZones.zoneHostname("invoices", { label: "plr" }, "example.com");
        expect(domainZones.zoneHostname("invoices", { label: "plr" }, "example.com")).toBe(first);
        expect(first.endsWith(".plr.example.com")).toBe(true);
    });

    it("separates two services that slug the same", () => {
        expect(domainZones.zoneHostname("My App", { label: "plr" }, "example.com")).not.toBe(
            domainZones.zoneHostname("my-app!", { label: "plr" }, "example.com")
        );
    });
});

describe("normalizeZoneName", () => {
    it("reduces what is typed to the one label it can be", () => {
        expect(domainZones.normalizeZoneName(" My App! ")).toBe("my-app");
    });

    it("never ends on a dash, however long the name was", () => {
        expect(domainZones.normalizeZoneName(`${"a".repeat(63)} b`)).toBe("a".repeat(63));
    });

    it("is empty when nothing usable is left", () => {
        expect(domainZones.normalizeZoneName("!!!")).toBe("");
        expect(domainZones.normalizeZoneName("")).toBe("");
    });
});

describe("namedZoneHostname", () => {
    it("takes the name exactly, with nothing appended", () => {
        expect(domainZones.namedZoneHostname("invoices", { label: "plr" }, "example.com")).toBe("invoices.plr.example.com");
    });

    it("puts a chosen name on the base domain for the empty-label zone", () => {
        expect(domainZones.namedZoneHostname("Invoices App", { label: "" }, "example.com")).toBe("invoices-app.example.com");
    });

    it("has no hostname to build from a name with no label in it", () => {
        expect(domainZones.namedZoneHostname("...", { label: "plr" }, "example.com")).toBe("");
    });
});

describe("randomZoneHostname", () => {
    it("never repeats a name", () => {
        const names = new Set(Array.from({ length: 50 }, () => domainZones.randomZoneHostname({ label: "plr" }, "example.com")));
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
        expect(domainZones.pickZone(zones, "deploy")?.label).toBe("plr");
    });

    it("honours an explicit label, including the base-domain zone", () => {
        expect(domainZones.pickZone(zones, "deploy", "apps")?.label).toBe("apps");
        expect(domainZones.pickZone(zones, "deploy", "nope")).toBeNull();
    });

    it("has nothing to offer for a scope with no zones", () => {
        expect(domainZones.pickZone([], "deploy")).toBeNull();
    });
});

describe("defaultZones", () => {
    it("covers Polaris and deployed services, each with a primary", () => {
        const zones = domainZones.defaultZones();
        expect(zones.filter((zone) => zone.scope === "polaris" && zone.primary)).toHaveLength(1);
        expect(zones.filter((zone) => zone.scope === "deploy" && zone.primary)).toHaveLength(1);
    });
});
