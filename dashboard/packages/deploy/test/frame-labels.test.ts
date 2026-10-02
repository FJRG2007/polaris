/**
 * Clickjacking protection as container labels - what a remote server's own edge sends
 * from the moment the container starts. Labels cannot route through the guard's proxy,
 * so this is always the blind fallback: `X-Frame-Options: SAMEORIGIN`, never a CSP
 * that would replace the app's own policy.
 */

import { describe, expect, it } from "vitest";
import { traefikLabels } from "../src/traefik.js";
import { parseAppEdgeConfig } from "@polaris/core";

const HEADER = "traefik.http.middlewares.web-headers.headers.customresponseheaders.X-Frame-Options";
const domains = [{ hostname: "shop.example.com", targetPort: 3000, certResolver: "le" as const }];

describe("framing protection on labels", () => {
    it("sends SAMEORIGIN on a service with no edge settings at all", () => {
        const labels = traefikLabels({
            serviceName: "web",
            network: "p",
            domains,
            waf: { frameAncestors: [] }
        });

        expect(labels[HEADER]).toBe("SAMEORIGIN");
        expect(labels["traefik.http.routers.web.middlewares"]).toContain("web-headers@docker");
        expect(Object.keys(labels).some((key) => key.includes("Content-Security-Policy"))).toBe(
            false
        );
    });

    it("sends nothing blind once other sites are allowed", () => {
        const labels = traefikLabels({
            serviceName: "web",
            network: "p",
            domains,
            waf: { frameAncestors: ["https://partner.example"] }
        });

        expect(labels[HEADER]).toBeUndefined();
    });

    it("yields to the service's own header setting", () => {
        const edge = parseAppEdgeConfig(JSON.stringify({ headers: { preset: "strict" } }));
        const labels = traefikLabels({
            serviceName: "web",
            network: "p",
            domains,
            edge,
            waf: { frameAncestors: [] }
        });

        expect(labels[HEADER]).toBe("DENY");
    });

    it("adds nothing when switched off", () => {
        const labels = traefikLabels({ serviceName: "web", network: "p", domains, waf: {} });

        expect(labels[HEADER]).toBeUndefined();
    });
});
