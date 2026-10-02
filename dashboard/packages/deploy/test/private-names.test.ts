/**
 * Private names: `<name>.polaris.internal` and the bare `<name>` on a network
 * of their own, one per environment, and the forwarder that answers port 80.
 *
 * The rules that matter: the names never ride on a network Polaris's own
 * containers are on (the proxy network, an environment network the dashboard
 * and the edge are attached to), each environment gets a names network of its
 * own, and a service with no names is rendered byte for byte as before.
 */

import { describe, expect, it } from "vitest";
import type { AppDeployPlan, DbDeployPlan } from "../src/runtime/driver.js";
import { appComposeSpec, dbComposeSpec, expandReplicas, forCompose, renderComposeYaml } from "../src/compose-spec.js";
import * as net from "../src/networks.js";
import {
    FORWARDER_IMAGE,
    crossProjectDomain,
    forwarderName,
    forwarderScript,
    namesFor,
    privateDomain,
    withPortForwarders
} from "../src/private-names.js";

const PROXY = "polaris-proxy";

function appPlan(overrides: Partial<AppDeployPlan> = {}): AppDeployPlan {
    return {
        ref: { name: "shop-api-abcd", project: "polaris-abcd1234" },
        build: { method: "image", name: "api", contextPath: ".", imageRef: "node:22" },
        env: {},
        replicas: 1,
        domains: [],
        volumes: [],
        ...overrides
    };
}

describe("the names networks", () => {
    it("are private, of their own kind, and one per environment", () => {
        for (const name of [net.namesNetwork("env-1"), net.serviceNamesNetwork("svc-1"), net.crossLinkNetwork("link-1")]) {
            expect(net.isPrivateNetwork(name)).toBe(true);
            expect(net.isNamesNetwork(name)).toBe(true);
        }
        expect(net.namesNetwork("env-1")).toBe(net.namesNetwork("env-1"));
        expect(net.namesNetwork("env-1")).not.toBe(net.namesNetwork("env-2"));
        // Never the same as the environment's own network, which the stack joins.
        expect(net.namesNetwork("env-1")).not.toBe(net.environmentNetwork("env-1"));
        for (const name of [net.environmentNetwork("env-1"), net.serviceNetwork("svc-1"), PROXY]) {
            expect(net.isNamesNetwork(name)).toBe(false);
        }
    });

    it("are added last to every mode, and only where the target carries names", () => {
        const base = { proxyNetwork: PROXY, environmentId: "env-1", serviceId: "a", joinsProxy: true };
        const names = net.namesNetwork("env-1");
        expect(net.serviceNetworks({ ...base, mode: "shared" })).toEqual([PROXY]);
        expect(net.serviceNetworks({ ...base, mode: "shared", names: true })).toEqual([PROXY, names]);
        expect(net.serviceNetworks({ ...base, mode: "environment", names: true })).toEqual([
            PROXY,
            net.environmentNetwork("env-1"),
            names
        ]);
        const links = [{ source: "a", target: "b" }];
        expect(net.serviceNetworks({ ...base, mode: "links", links, names: true })).toEqual([
            PROXY,
            net.serviceNetwork("a"),
            net.serviceNetwork("b"),
            net.serviceNamesNetwork("a"),
            net.serviceNamesNetwork("b")
        ]);
        expect(
            net.serviceNetworks({ ...base, mode: "environment", names: true, crossLinks: [net.crossLinkNetwork("l1")] }).at(-1)
        ).toBe(net.crossLinkNetwork("l1"));
    });

    it("carry a service's own names where the services that may call it are", () => {
        expect(net.ownNamesNetwork({ mode: "environment", environmentId: "env-1", serviceId: "a" })).toBe(net.namesNetwork("env-1"));
        expect(net.ownNamesNetwork({ mode: "shared", environmentId: "env-1", serviceId: "a" })).toBe(net.namesNetwork("env-1"));
        expect(net.ownNamesNetwork({ mode: "links", environmentId: "env-1", serviceId: "a" })).toBe(net.serviceNamesNetwork("a"));
    });

    it("are never handed to a tunnel connector or an edge", () => {
        expect(net.privateNetworksOf([PROXY, net.environmentNetwork("e"), net.namesNetwork("e")])).toEqual([net.environmentNetwork("e")]);
        const script = net.ensurePrivateNetworksScript([net.environmentNetwork("e"), net.namesNetwork("e")], false).join("\n");
        // Created like any private network, dual stack first...
        expect(script).toContain(`--ipv6 ${net.namesNetwork("e")}`);
        // ...but the edge is connected to the environment network only.
        expect(script).toContain(`docker network connect ${net.environmentNetwork("e")}`);
        expect(script).not.toContain(`docker network connect ${net.namesNetwork("e")}`);
        // An overlay is never asked for IPv6.
        expect(net.ensurePrivateNetworksScript([net.namesNetwork("e")], true).join("\n")).not.toContain("--ipv6");
    });
});

describe("a service's names in its spec", () => {
    const names = net.namesNetwork("env-1");

    it("are the full and the bare form of each name", () => {
        expect(privateDomain("api")).toBe("api.polaris.internal");
        expect(crossProjectDomain("api", "shop")).toBe("api.shop.polaris.internal");
        expect(namesFor("api", ["dymoapi"])).toEqual(["api.polaris.internal", "api", "dymoapi.polaris.internal", "dymoapi"]);
    });

    it("ride only on the names network, never on the proxy network", () => {
        const plan = appPlan({ networks: [PROXY, names], networkAliases: { [names]: namesFor("api") } });
        const service = appComposeSpec(plan, "node:22", PROXY).services[0]!;
        expect(service.networkAliases).toEqual({ [names]: ["api.polaris.internal", "api"] });
        const yaml = renderComposeYaml(appComposeSpec(plan, "node:22", PROXY), "/v", "/m");
        expect(yaml).toContain(`      ${PROXY}: {}\n`);
        expect(yaml).toContain(`      ${names}:\n        aliases:\n          - "api.polaris.internal"\n          - "api"\n`);
    });

    it("are dropped for a network the service does not join, and absent when there are none", () => {
        const plan = appPlan({ networks: [PROXY], networkAliases: { [names]: ["api"] } });
        expect(appComposeSpec(plan, "node:22", PROXY).services[0]!.networkAliases).toBeUndefined();
        expect(renderComposeYaml(appComposeSpec(appPlan(), "node:22", PROXY), "/v", "/m")).toContain(
            `    networks:\n      - ${PROXY}\n`
        );
    });

    it("follow every copy of a replicated service", () => {
        const plan = appPlan({ replicas: 2, networks: [PROXY, names], networkAliases: { [names]: ["api"] } });
        const spec = expandReplicas(appComposeSpec(plan, "node:22", PROXY));
        expect(spec.services.map((service) => service.networkAliases?.[names])).toEqual([["api"], ["api"]]);
    });

    it("go on the database's own container only", () => {
        const plan: DbDeployPlan = {
            ref: { name: "shop-db-abcd", project: "polaris-db-1" },
            image: "postgres:17",
            env: {},
            volumeName: "pg",
            dataPath: "/var/lib/postgresql/data",
            networks: [net.environmentNetwork("env-1"), names],
            networkAliases: { [names]: namesFor("postgres") },
            members: [
                { name: "shop-db-abcd", env: {}, volumeName: "pg1" },
                { name: "shop-db-abcd-n2", env: {}, volumeName: "pg2" }
            ]
        };
        const services = dbComposeSpec(plan, PROXY).services;
        expect(services[0]!.networkAliases?.[names]).toContain("postgres.polaris.internal");
        expect(services[1]!.networkAliases).toBeUndefined();
        const single = dbComposeSpec({ ...plan, members: undefined }, PROXY).services[0]!;
        expect(single.networkAliases?.[names]).toEqual(["postgres.polaris.internal", "postgres"]);
    });
});

describe("the port-80 forwarder", () => {
    const names = net.namesNetwork("env-1");
    const named = () =>
        appComposeSpec(appPlan({ networks: [PROXY, names], networkAliases: { [names]: ["api"] } }), "node:22", PROXY);

    it("stands beside each copy that has names, sharing its namespace", () => {
        const plan = appPlan({ replicas: 2, networks: [PROXY, names], networkAliases: { [names]: ["api"] } });
        const spec = withPortForwarders(expandReplicas(appComposeSpec(plan, "node:22", PROXY)), 3000);
        const forwarders = spec.services.filter((service) => service.networkMode);
        expect(forwarders.map((service) => service.networkMode)).toEqual([
            "service:shop-api-abcd",
            "service:shop-api-abcd-r2"
        ]);
        for (const forwarder of forwarders) {
            expect(forwarder.image).toBe(FORWARDER_IMAGE);
            expect(forwarder.networks).toEqual([]);
            expect(forwarder.ports).toEqual([]);
            expect(forwarder.extraHosts).toBeUndefined();
            expect(forwarder.command?.[0]).toContain("TCP4:127.0.0.1:3000");
        }
    });

    it("is left out where the service listens on 80, has no names, or no port is asked", () => {
        expect(withPortForwarders(named(), 80).services).toHaveLength(1);
        expect(withPortForwarders(named(), undefined).services).toHaveLength(1);
        expect(withPortForwarders(appComposeSpec(appPlan(), "node:22", PROXY), 3000).services).toHaveLength(1);
    });

    it("is pinned by digest, fits a DNS label and runs one line", () => {
        expect(FORWARDER_IMAGE).toMatch(/@sha256:[a-f0-9]{64}$/);
        expect(forwarderName("x".repeat(80)).length).toBeLessThanOrEqual(63);
        expect(forwarderName("api")).toBe("api-p80");
        // Copies whose names differ only past the cut still get forwarders of their own.
        const long = "x".repeat(60);
        expect(forwarderName(`${long}-r2`)).not.toBe(forwarderName(`${long}-r3`));
        expect(forwarderName(`${long}-r2`).length).toBeLessThanOrEqual(63);
        // A control character would be refused by the daemon and folded by YAML.
        expect(forwarderScript(3000)).not.toMatch(/[\x00-\x1f]/);
        // And survives the compose escaping every spec crosses: `$` doubled.
        const escaped = forCompose(withPortForwarders(named(), 3000));
        expect(escaped.services[1]!.command?.[0]).toContain("$$pid");
    });

    it("waits for the service's port, and stays idle where the service answers on 80 itself", () => {
        const script = forwarderScript(3000);
        const wait = script.indexOf(":0BB8 ");
        const own80 = script.indexOf(":0050 ");
        expect(wait).toBeGreaterThan(-1);
        expect(own80).toBeGreaterThan(wait);
        expect(script.indexOf("TCP4-LISTEN:80")).toBeGreaterThan(own80);
    });

    it("renders as a shared namespace for a server reached over SSH", () => {
        const yaml = renderComposeYaml(withPortForwarders(named(), 3000), "/v", "/m");
        expect(yaml).toContain('    network_mode: "service:shop-api-abcd"\n');
    });
});
