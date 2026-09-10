import { describe, expect, it } from "vitest";
import { onboardingScript } from "../src/onboarding.js";
import type { AppDeployPlan, DbDeployPlan } from "../src/runtime/driver.js";
import { appComposeSpec, dbComposeSpec, renderComposeYaml } from "../src/compose-spec.js";
import {
    ensurePrivateNetworksScript,
    environmentNetwork,
    fallbackSubnet,
    isPrivateNetwork,
    joinsProxy,
    linksOfLayout,
    privateNetworksOf,
    serviceNetwork,
    serviceNetworks
} from "../src/networks.js";

const PROXY = "polaris-proxy";

function appPlan(overrides: Partial<AppDeployPlan> = {}): AppDeployPlan {
    return {
        ref: { name: "shop-web-abc123", project: "polaris-abcd1234" },
        build: { method: "image", name: "web", contextPath: ".", imageRef: "nginx:1.27" },
        env: {},
        replicas: 1,
        domains: [{ hostname: "shop.example.test", targetPort: 80, certResolver: "le" }],
        volumes: [],
        ...overrides
    };
}

function dbPlan(overrides: Partial<DbDeployPlan> = {}): DbDeployPlan {
    return {
        ref: { name: "shop-db-abc123", project: "polaris-db-abcd1234" },
        image: "postgres:16",
        env: {},
        volumeName: "postgres-data-abcd1234",
        dataPath: "/var/lib/postgresql/data",
        ...overrides
    };
}

describe("private network names", () => {
    it("derives one stable name per environment and per service, in the shape the daemon accepts", () => {
        const environment = environmentNetwork("0192a0b1-0000-7000-8000-000000000001");
        expect(environment).toBe(environmentNetwork("0192a0b1-0000-7000-8000-000000000001"));
        expect(environment).toMatch(/^polaris-net-e[a-f0-9]{10}$/);
        expect(serviceNetwork("0192a0b1-0000-7000-8000-000000000001")).toMatch(
            /^polaris-net-s[a-f0-9]{10}$/
        );
        expect(serviceNetwork("x")).not.toBe(environmentNetwork("x"));
        expect(isPrivateNetwork(environment)).toBe(true);
        for (const other of [
            PROXY,
            "polaris-hub",
            "polaris-net-",
            "polaris-net-x0123456789",
            "polaris-net-eABCDEF0123"
        ]) {
            expect(isPrivateNetwork(other)).toBe(false);
        }
    });

    it("tries the same fallback ranges as the daemon", () => {
        // FNV-1a of the name, plus the attempt: the daemon's test pins the same shape.
        const first = fallbackSubnet("polaris-net-e0123456789", 0);
        expect(first).toMatch(/^10\.211\.\d{1,3}\.0\/24$/);
        expect(first).toBe(fallbackSubnet("polaris-net-e0123456789", 0));
        expect(first).not.toBe(fallbackSubnet("polaris-net-e0123456789", 1));
        // FNV-1a("a") is 0xe40c292c, whose low byte is 0x2c.
        expect(fallbackSubnet("a", 0)).toBe("10.211.44.0/24");
        expect(fallbackSubnet("a", 255)).toBe("10.211.43.0/24");
    });
});

describe("which networks a service joins", () => {
    const base = { proxyNetwork: PROXY, environmentId: "env-1", serviceId: "svc-a" };

    it("leaves every service of a shared environment on the proxy network, as before", () => {
        expect(serviceNetworks({ ...base, mode: "shared", joinsProxy: false })).toEqual([PROXY]);
    });

    it("puts an environment's services on its own network, and on the proxy only when the edge needs it", () => {
        const own = environmentNetwork("env-1");
        expect(serviceNetworks({ ...base, mode: "environment", joinsProxy: true })).toEqual([
            PROXY,
            own
        ]);
        expect(serviceNetworks({ ...base, mode: "environment", joinsProxy: false })).toEqual([own]);
    });

    it("joins in links mode only the networks of the services it links to", () => {
        const links = [
            { source: "svc-a", target: "db-1" },
            { source: "svc-a", target: "svc-b" },
            { source: "svc-c", target: "svc-a" },
            { source: "svc-a", target: "svc-a" }
        ];
        const joined = serviceNetworks({ ...base, mode: "links", joinsProxy: false, links });
        expect(joined[0]).toBe(serviceNetwork("svc-a"));
        expect(new Set(joined)).toEqual(
            new Set([serviceNetwork("svc-a"), serviceNetwork("db-1"), serviceNetwork("svc-b")])
        );
        // svc-c links to svc-a, so it is svc-c that joins svc-a's network, not the reverse.
        expect(joined).not.toContain(serviceNetwork("svc-c"));
        const database = serviceNetworks({
            ...base,
            serviceId: "db-1",
            mode: "links",
            joinsProxy: false,
            links
        });
        expect(database).toEqual([serviceNetwork("db-1")]);
    });

    it("reads links out of a stored canvas layout, and nothing out of a malformed one", () => {
        expect(
            linksOfLayout('{"pos":{},"links":[{"source":"a","target":"b"},{"source":1},null]}')
        ).toEqual([{ source: "a", target: "b" }]);
        expect(linksOfLayout("{")).toEqual([]);
        expect(linksOfLayout(null)).toEqual([]);
        expect(linksOfLayout('{"links":"no"}')).toEqual([]);
    });

    it("keeps on the proxy network only what the edge dials there", () => {
        // This machine's edge dials a published port on the host's address.
        expect(joinsProxy({ local: true, published: true, routed: true })).toBe(false);
        // A closed port is dialled by name.
        expect(joinsProxy({ local: true, published: false, routed: true })).toBe(true);
        // Another server routes by the container's labels, over the proxy network.
        expect(joinsProxy({ local: false, published: true, routed: true })).toBe(true);
        // Nothing routes to it at all.
        expect(joinsProxy({ local: false, published: false, routed: false })).toBe(false);
    });

    it("lists only the private networks out of a mixed list", () => {
        const own = environmentNetwork("env-1");
        expect(privateNetworksOf([PROXY, own, "polaris-hub", own])).toEqual([own]);
    });
});

describe("the compose a private service is deployed with", () => {
    it("keeps a plan with no networks exactly where it always was", () => {
        const spec = appComposeSpec(appPlan(), "nginx:1.27", PROXY);
        expect(spec.services[0]?.networks).toEqual([PROXY]);
        expect(spec.networks).toEqual([PROXY]);
        expect(spec.services[0]?.labels["traefik.docker.network"]).toBe(PROXY);
        expect(dbComposeSpec(dbPlan(), PROXY).networks).toEqual([PROXY]);
    });

    it("joins the planned networks, and points the edge at the one it can reach the service on", () => {
        const own = environmentNetwork("env-1");
        const routed = appComposeSpec(appPlan({ networks: [PROXY, own] }), "nginx:1.27", PROXY);
        expect(routed.services[0]?.networks).toEqual([PROXY, own]);
        expect(routed.services[0]?.labels["traefik.docker.network"]).toBe(PROXY);

        const unrouted = appComposeSpec(appPlan({ networks: [own] }), "nginx:1.27", PROXY);
        expect(unrouted.services[0]?.networks).toEqual([own]);
        expect(unrouted.networks).toEqual([own]);
        expect(unrouted.services[0]?.labels["traefik.docker.network"]).toBe(own);
    });

    it("keeps a database off the proxy network when it has a private one", () => {
        const own = environmentNetwork("env-1");
        const spec = dbComposeSpec(dbPlan({ networks: [own] }), PROXY);
        expect(spec.services[0]?.networks).toEqual([own]);
        const yaml = renderComposeYaml(spec, "/v", "/m");
        expect(yaml).toContain(`  ${own}:\n    external: true`);
        expect(yaml).not.toContain(PROXY);
    });

    it("still adds the extra networks a plan asks for after the planned ones", () => {
        const own = environmentNetwork("env-1");
        const spec = appComposeSpec(
            appPlan({ networks: [own], extraNetworks: ["polaris-hub", own] }),
            "img",
            PROXY
        );
        expect(spec.services[0]?.networks).toEqual([own, "polaris-hub"]);
    });
});

describe("making private networks on another server", () => {
    it("creates each private network once, with a fallback, and attaches that server's edge", () => {
        const own = environmentNetwork("env-1");
        const script = ensurePrivateNetworksScript([PROXY, own, own, "polaris-hub"], false);
        expect(script).toHaveLength(2);
        expect(script[0]).toContain(`if ! docker network inspect ${own} >/dev/null 2>&1; then`);
        expect(script[0]).toContain(
            `docker network create --label polaris.network=private --driver bridge ${own}`
        );
        expect(script[0]).toContain(`--subnet "$s" ${own}`);
        expect(script[0]).toContain(fallbackSubnet(own, 0));
        expect(script[0]).toContain("exit 1");
        expect(script[1]).toBe(
            `for c in polaris-traefik polaris-edge-guard; do docker network connect ${own} "$c" >/dev/null 2>&1 || true; done`
        );
        // The shared networks are never created or touched here.
        expect(script.join("\n")).not.toContain("polaris-hub");
        expect(script.join("\n")).not.toContain(`network create ${PROXY}`);
    });

    it("makes an attachable overlay for a swarm", () => {
        const script = ensurePrivateNetworksScript([environmentNetwork("env-1")], true);
        expect(script[0]).toContain("--driver overlay --attachable");
    });

    it("has nothing to do for a service on the shared networks alone", () => {
        expect(ensurePrivateNetworksScript([PROXY, "polaris-hub"], false)).toEqual([]);
    });

    it("rejoins the private networks when the edge is recreated", () => {
        const script = onboardingScript({ proxyNetwork: PROXY, acmeEmail: "ops@example.test" });
        expect(script).toContain("docker network ls -q --filter label=polaris.network=private");
        expect(script.indexOf("label=polaris.network=private")).toBeGreaterThan(
            script.indexOf("docker run -d --name polaris-traefik")
        );
    });
});
