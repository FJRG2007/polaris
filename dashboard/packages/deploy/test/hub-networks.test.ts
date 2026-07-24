import { mkdirSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { appComposeSpec, renderComposeYaml } from "../src/compose-spec.js";
import type { AppDeployPlan } from "../src/runtime/driver.js";

// Evidence: prove that a locally-installed messaging hub reaches the web's inbound
// ingest. The bridge posts inbound events to WEB_INGEST_URL, which for a local hub
// is rewritten to the web's service DNS - unreachable unless the hub also shares a
// network with the web. These tests render the actual compose the hub deploys with
// and assert it joins the dedicated web<->hub network on top of the proxy network,
// while a normal app is left on the proxy network alone (routing unchanged).
const PROXY_NETWORK = "polaris-proxy";
const HUB_NETWORK = "polaris-hub";
const WEB_INTERNAL_INGEST_URL = "http://web:3000/api/inbox/ingest";
const EVIDENCE_DIR = "C:/Users/admin/AppData/Local/Temp/enigma-gate-evidence/01KY9R1BCWRK53KKJGWV6D1MRH";

function basePlan(overrides: Partial<AppDeployPlan> = {}): AppDeployPlan {
    return {
        ref: { name: "messaging-bridge", project: "polaris-abcd1234" },
        build: { method: "image", name: "messaging-bridge", contextPath: "/ctx", imageRef: "polaris/messaging-bridge:latest" },
        env: { BRIDGE_TOKEN: "tok", INGEST_KEY: "key", WEB_INGEST_URL: WEB_INTERNAL_INGEST_URL },
        replicas: 1,
        domains: [],
        volumes: [],
        ...overrides
    };
}

describe("hub deploy networks", () => {
    it("joins a local hub to the proxy network AND the dedicated hub network", () => {
        const plan = basePlan({ extraNetworks: [HUB_NETWORK] });
        const spec = appComposeSpec(plan, "polaris/messaging-bridge:latest", PROXY_NETWORK);

        // Service attaches to both networks (proxy first so edge routing is unchanged).
        expect(spec.services[0].networks).toEqual([PROXY_NETWORK, HUB_NETWORK]);
        // Top-level network set mirrors the service's - both must exist on the target.
        expect(spec.networks).toEqual([PROXY_NETWORK, HUB_NETWORK]);
        // The bridge points its inbound forwards at the web by internal service DNS.
        expect(spec.services[0].env.WEB_INGEST_URL).toBe(WEB_INTERNAL_INGEST_URL);
    });

    it("leaves a normal app on the proxy network alone (routing unchanged)", () => {
        const spec = appComposeSpec(basePlan(), "img:latest", PROXY_NETWORK);
        expect(spec.services[0].networks).toEqual([PROXY_NETWORK]);
        expect(spec.networks).toEqual([PROXY_NETWORK]);
    });

    it("never duplicates the proxy network when it is also listed as extra", () => {
        const plan = basePlan({ extraNetworks: [PROXY_NETWORK, HUB_NETWORK] });
        const spec = appComposeSpec(plan, "img:latest", PROXY_NETWORK);
        expect(spec.services[0].networks).toEqual([PROXY_NETWORK, HUB_NETWORK]);
    });

    it("renders remote-path compose YAML with the hub network wired end to end", () => {
        const plan = basePlan({ extraNetworks: [HUB_NETWORK] });
        const spec = appComposeSpec(plan, "polaris/messaging-bridge:latest", PROXY_NETWORK);
        const yaml = renderComposeYaml(spec, "/var/polaris/volumes", "/var/polaris/mounts");

        // The service joins both networks and forwards inbound events to the web's
        // internal ingest - the exact reachability the fix restores.
        expect(yaml).toContain("    networks:\n      - polaris-proxy\n      - polaris-hub");
        expect(yaml).toContain(`WEB_INGEST_URL=${WEB_INTERNAL_INGEST_URL}`);
        // Both networks are declared external at the top level, so the deploy attaches
        // to the already-created named networks rather than minting fresh ones.
        expect(yaml).toContain("networks:\n  polaris-proxy:\n    external: true\n  polaris-hub:\n    external: true");

        // Persist the rendered hub compose as reviewer-visible evidence.
        const normal = renderComposeYaml(
            appComposeSpec(basePlan(), "img:latest", PROXY_NETWORK),
            "/var/polaris/volumes",
            "/var/polaris/mounts"
        );
        mkdirSync(EVIDENCE_DIR, { recursive: true });
        writeFileSync(
            `${EVIDENCE_DIR}/hub-compose.rendered.yml`,
            `# Local messaging hub (extraNetworks: [polaris-hub]) - joins the web<->hub network:\n${yaml}\n` +
                `# Normal app (no extraNetworks) - proxy network only, routing unchanged:\n${normal}`,
            "utf8"
        );
    });
});
