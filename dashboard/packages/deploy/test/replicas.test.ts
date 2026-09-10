/**
 * A service run as several copies: one named container per copy on plain compose,
 * the first under the service's own name, and labels that let the edge merge them
 * into one balanced service - pinned per visitor when asked, health-checked only
 * where another copy exists.
 */

import { describe, expect, it } from "vitest";
import { parseAppEdgeConfig } from "@polaris/core";
import { traefikLabels } from "../src/traefik.js";
import { expandReplicas, replicaNames, type ComposeSpec } from "../src/compose-spec.js";

describe("a service with more than one copy", () => {
    const spec: ComposeSpec = {
        project: "p",
        services: [
            {
                name: "web",
                image: "nginx",
                env: { A: "b" },
                ports: [{ host: 20001, container: 80 }],
                volumes: [],
                labels: { "traefik.enable": "true" },
                networks: ["polaris-proxy"],
                replicas: 3
            }
        ],
        volumes: [],
        networks: ["polaris-proxy"]
    };

    it("runs one named service per copy, the first under the service's own name", () => {
        const expanded = expandReplicas(spec);
        expect(expanded.services.map((service) => service.name)).toEqual([
            "web",
            "web-r2",
            "web-r3"
        ]);
        expect(expanded.services[0]?.ports).toHaveLength(1);
        expect(expanded.services[1]?.ports).toHaveLength(0);
        expect(expanded.services[2]?.aliases).toEqual(["web"]);
        expect(expanded.services[2]?.labels).toEqual({ "traefik.enable": "true" });
        expect(expanded.services.every((service) => service.replicas === undefined)).toBe(true);
    });

    it("leaves a single copy exactly as it was", () => {
        const single = { ...spec, services: [{ ...spec.services[0]!, replicas: undefined }] };
        expect(expandReplicas(single)).toEqual(single);
    });

    it("keeps every copy's name a DNS label", () => {
        const names = replicaNames("a".repeat(63), 10);
        expect(names[0]).toHaveLength(63);
        expect(names[9]).toHaveLength(63);
        expect(names[9]?.endsWith("-r10")).toBe(true);
    });
});

describe("the labels every copy carries", () => {
    const edge = (balancing: { sticky: boolean; healthPath: string | null }) => ({
        ...parseAppEdgeConfig("{}"),
        balancing
    });
    const input = {
        serviceName: "web",
        network: "polaris-proxy",
        domains: [{ hostname: "shop.example.com", targetPort: 80, certResolver: "le" as const }]
    };

    it("pin a visitor to one copy when the service asks", () => {
        const labels = traefikLabels({ ...input, edge: edge({ sticky: true, healthPath: null }) });
        expect(labels["traefik.http.services.web.loadbalancer.sticky.cookie.name"]).toBe(
            "polaris_lb"
        );
    });

    it("check health only where there is another copy to send traffic to", () => {
        const asked = edge({ sticky: false, healthPath: "/healthz" });
        expect(
            traefikLabels({ ...input, edge: asked, replicas: 2 })[
                "traefik.http.services.web.loadbalancer.healthcheck.path"
            ]
        ).toBe("/healthz");
        expect(
            traefikLabels({ ...input, edge: asked, replicas: 1 })[
                "traefik.http.services.web.loadbalancer.healthcheck.path"
            ]
        ).toBeUndefined();
    });
});
