import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const COMPOSE = readFileSync(
    new URL("../../../../docker/docker-compose.yml", import.meta.url),
    "utf8"
);

/** The `hostd` service's block, up to the next top-level service. */
function hostdBlock(): string {
    const start = COMPOSE.indexOf("\n  hostd:");
    const rest = COMPOSE.slice(start + 1);
    const next = rest.search(/\n {2}[a-z0-9_-]+:\n/);
    return next < 0 ? rest : rest.slice(0, next);
}

describe("the host daemon's shares outlive an update", () => {
    // A kernel SMB/NFS mount keeps its connection in the network namespace of the
    // process that mounted it. On a container network, recreating the daemon on an
    // update took that namespace's interface away and every share went dead.
    it("mounts from the host's network namespace", () => {
        expect(hostdBlock()).toMatch(/\n {4}network_mode: host\n/);
    });

    it("joins no container network, which host networking cannot", () => {
        expect(hostdBlock()).not.toMatch(/\n {4}networks:/);
    });
});
