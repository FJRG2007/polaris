/**
 * A service's edge settings as container labels - what a remote server's own edge
 * enforces from the moment the container starts, before Polaris pushes anything - and
 * the escaping every value needs on its way into a compose file.
 */

import { describe, expect, it } from "vitest";
import { traefikLabels } from "../src/traefik.js";
import { parseAppEdgeConfig } from "@polaris/core";
import { forCompose, renderComposeYaml, type ComposeSpec } from "../src/compose-spec.js";

const edge = parseAppEdgeConfig(
    JSON.stringify({
        rateLimits: [{ average: 20, burst: 40 }, { path: "/login", average: 5, burst: 5 }],
        concurrency: 10,
        headers: { preset: "recommended" },
        redirects: [{ kind: "regex", regex: "^https://a\\.example\\.com/(.*)", replacement: "https://b.example.com/${1}" }],
        rewrites: [{ kind: "strip-prefix", prefix: "/api" }]
    })
);

describe("edge labels", () => {
    const labels = traefikLabels({
        serviceName: "web",
        network: "polaris-proxy",
        domains: [{ hostname: "shop.example.com", targetPort: 3000, certResolver: "le" }],
        edge
    });

    it("chains the allowlist, the limits, the guard and then the answer changes, in that order", () => {
        expect(labels["traefik.http.routers.web.middlewares"]).toBe(
            "web-rate-0@docker,web-inflight@docker,web-headers@docker,web-redirect-0@docker,web-rewrite-0@docker"
        );
    });

    it("writes the limits and the headers", () => {
        expect(labels["traefik.http.middlewares.web-rate-0.ratelimit.average"]).toBe("20");
        expect(labels["traefik.http.middlewares.web-rate-0.ratelimit.sourcecriterion.ipstrategy.depth"]).toBe("0");
        expect(labels["traefik.http.middlewares.web-inflight.inflightreq.amount"]).toBe("10");
        expect(labels["traefik.http.middlewares.web-headers.headers.customresponseheaders.X-Content-Type-Options"]).toBe(
            "nosniff"
        );
    });

    it("gives a path limit its own router over that path", () => {
        expect(labels["traefik.http.routers.web-path-0.rule"]).toBe("Host(`shop.example.com`) && PathPrefix(`/login`)");
        expect(labels["traefik.http.routers.web-path-0.priority"]).toBe("41");
        expect(labels["traefik.http.routers.web-path-0.middlewares"]).toContain("web-rate-1@docker");
    });

    it("states a rank on every router", () => {
        expect(labels["traefik.http.routers.web.priority"]).toBe("40");
        expect(labels["traefik.http.routers.web-web.priority"]).toBe("40");
    });

    it("routes a wildcard with the edge's own certificate, and drops a hostname that could break a rule", () => {
        const wild = traefikLabels({
            serviceName: "w",
            network: "n",
            domains: [
                { hostname: "*.example.com", targetPort: 80, certResolver: "le" },
                { hostname: "bad`name.example.com", targetPort: 80, certResolver: "le" }
            ]
        });
        expect(wild["traefik.http.routers.w.rule"]).toContain("HostRegexp(");
        expect(wild["traefik.http.routers.w.tls.certresolver"]).toBeUndefined();
        expect(Object.values(wild).join(" ")).not.toContain("bad`name");
    });
});

describe("values on their way into a compose file", () => {
    const spec: ComposeSpec = {
        project: "p",
        services: [
            {
                name: "web",
                image: "nginx:1.27",
                env: { PASSWORD: "pa$word", PLAIN: "x" },
                ports: [],
                volumes: [],
                labels: { "traefik.http.middlewares.r.redirectregex.replacement": "https://b/${1}" },
                command: ["sh", "-c", "echo $HOME"],
                networks: ["polaris-proxy"]
            }
        ],
        volumes: [],
        networks: ["polaris-proxy"]
    };

    it("doubles every dollar, which is compose's own escape for a literal one", () => {
        const escaped = forCompose(spec).services[0]!;
        expect(escaped.env.PASSWORD).toBe("pa$$word");
        expect(escaped.env.PLAIN).toBe("x");
        expect(escaped.labels["traefik.http.middlewares.r.redirectregex.replacement"]).toBe("https://b/$${1}");
        expect(escaped.command).toEqual(["sh", "-c", "echo $$HOME"]);
        expect(renderComposeYaml(forCompose(spec), "/vol", "/mnt")).toContain('"PASSWORD=pa$$word"');
    });
});
