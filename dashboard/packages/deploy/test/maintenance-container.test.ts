/**
 * A maintenance container: one that mounts another project's volumes by their
 * exact names, declared external so it never creates or removes them, and may
 * run a script in place of its image's entrypoint. The remote renderer has to say
 * exactly what the daemon says.
 */

import { describe, expect, it } from "vitest";
import { forCompose, renderComposeYaml, type ComposeSpec } from "../src/compose-spec.js";

const spec: ComposeSpec = {
    project: "polaris-mailexport-1",
    services: [
        {
            name: "polaris-mailexport-1",
            image: "stalwartlabs/stalwart:v0.16",
            entrypoint: ["/bin/sh", "-c"],
            command: ["echo $HOME"],
            env: {},
            ports: [],
            volumes: [
                { source: "polaris-abc_stalwart-data", target: "/var/lib/stalwart", kind: "volume" }
            ],
            labels: {},
            networks: [],
            restart: "no"
        }
    ],
    volumes: [],
    networks: [],
    externalVolumes: ["polaris-abc_stalwart-data"]
};

describe("a maintenance container", () => {
    it("mounts an existing volume without owning it, and replaces the entrypoint", () => {
        const yaml = renderComposeYaml(forCompose(spec), "/v", "/m");
        expect(yaml).toContain('    entrypoint: ["/bin/sh", "-c"]');
        expect(yaml).toContain("  polaris-abc_stalwart-data:\n    external: true");
        // Escaped like every other value compose would interpolate.
        expect(yaml).toContain('command: ["echo $$HOME"]');
    });

    it("renders neither when an ordinary service asks for neither", () => {
        const plain: ComposeSpec = {
            ...spec,
            services: [{ ...spec.services[0]!, entrypoint: undefined }],
            externalVolumes: undefined
        };
        const yaml = renderComposeYaml(plain, "/v", "/m");
        expect(yaml).not.toContain("entrypoint");
        expect(yaml).not.toContain("external: true");
    });
});
