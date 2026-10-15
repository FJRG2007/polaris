/**
 * A private address on container labels: the route a server's edge falls back to
 * when Polaris' own route for the address is missing still asks for a sign-in, and
 * only on that address - the service's public ones stay public.
 */

import { describe, expect, it } from "vitest";
import { traefikLabels } from "../src/traefik.js";
import { decodeGuardRule } from "@polaris/core/waf";

const WAF_HEADER = (middleware: string) =>
    `traefik.http.middlewares.${middleware}.headers.customrequestheaders.X-Polaris-Waf`;

describe("a private address on labels", () => {
    const labels = traefikLabels({
        serviceName: "web",
        network: "p",
        domains: [
            { hostname: "shop.example.com", targetPort: 3000, certResolver: "le" },
            {
                hostname: "admin.example.com",
                targetPort: 3000,
                certResolver: "le",
                waf: {
                    requireLogin: true,
                    loginUrl: "https://polaris.example.com",
                    loginAllowLists: [[{ ref: "group:eng" }]],
                    loginMaxAge: 900
                }
            }
        ]
    });

    it("puts the guard in front of the private address with its sign-in rule", () => {
        expect(labels["traefik.http.routers.web-1.middlewares"]).toContain(
            "web-1-own-waf-ctx@docker"
        );
        expect(labels["traefik.http.routers.web-1.middlewares"]).toContain(
            "polaris-waf-guard@docker"
        );
        const rule = decodeGuardRule(labels[WAF_HEADER("web-1-own-waf-ctx")]!);
        expect(rule.requireLogin).toBe(true);
        expect(rule.loginMaxAge).toBe(900);
        expect(rule.loginAllowLists).toEqual([[{ ref: "group:eng" }]]);
    });

    it("leaves the service's public address without a guard", () => {
        expect(labels["traefik.http.routers.web-0.middlewares"]).toBeUndefined();
    });
});
