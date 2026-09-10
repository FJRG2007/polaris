/**
 * Resource limits render under `deploy.resources`, which plain compose and swarm
 * both read, and every copy of a replicated service carries them.
 */

import { describe, expect, it } from "vitest";
import {
    dbComposeSpec,
    deployBlockLines,
    expandReplicas,
    renderComposeYaml
} from "../src/compose-spec.js";

describe("resource limits", () => {
    it("render the CPU as a quoted decimal and the memory in MB", () => {
        expect(deployBlockLines({ cpus: 1.5, memoryMb: 768 })).toEqual([
            "    deploy:",
            "      resources:",
            "        limits:",
            '          cpus: "1.5"',
            "          memory: 768M"
        ]);
    });

    it("render nothing for a service without them", () => {
        expect(deployBlockLines({})).toEqual([]);
    });

    it("sit beside a swarm update in the same block", () => {
        const lines = deployBlockLines({ rollingUpdate: true, memoryMb: 256 });
        expect(lines.slice(0, 3)).toEqual([
            "    deploy:",
            "      mode: replicated",
            "      replicas: 1"
        ]);
        expect(lines).toContain("          memory: 256M");
        expect(lines).toContain("        order: start-first");
    });

    it("reach a database's container", () => {
        const spec = dbComposeSpec(
            {
                ref: { name: "pg", project: "p" },
                image: "postgres:17",
                env: {},
                volumeName: "pg-data",
                dataPath: "/var/lib/postgresql/data",
                limits: { cpus: 2, memoryMb: 1024 }
            },
            "polaris-proxy"
        );
        expect(renderComposeYaml(spec, "/v", "/m")).toContain(
            '          cpus: "2"\n          memory: 1024M'
        );
    });

    it("hold for every copy of a replicated service", () => {
        const expanded = expandReplicas({
            project: "p",
            services: [
                {
                    name: "web",
                    image: "nginx",
                    env: {},
                    ports: [],
                    volumes: [],
                    labels: {},
                    networks: ["n"],
                    replicas: 2,
                    cpus: 0.5
                }
            ],
            volumes: [],
            networks: ["n"]
        });
        expect(expanded.services.map((service) => service.cpus)).toEqual([0.5, 0.5]);
    });
});
