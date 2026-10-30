import { describe, expect, it } from "vitest";
import { holdersCanBeFreed, readPortHolders } from "../../src/lib/backup-access/port-holders";

describe("relay port holders", () => {
    it("names a host process once, however many workers it has", () => {
        const output = [
            'LISTEN 0 511 0.0.0.0:80 0.0.0.0:* users:(("nginx",pid=3,fd=6),("nginx",pid=2,fd=6))',
            'LISTEN 0 511 [::]:443 [::]:* users:(("nginx",pid=3,fd=9))'
        ].join("\n");
        expect(readPortHolders(output)).toEqual(["nginx"]);
    });

    it("does not count Polaris' own edge or Docker's forwarder", () => {
        const output = [
            'LISTEN 0 4096 0.0.0.0:80 0.0.0.0:* users:(("docker-proxy",pid=9,fd=4))',
            "container=polaris-traefik"
        ].join("\n");
        expect(readPortHolders(output)).toEqual([]);
    });

    it("names a foreign container, and a listener the server will not name", () => {
        expect(readPortHolders("container=someones-proxy")).toEqual(["someones-proxy"]);
        expect(readPortHolders("LISTEN 0 511 0.0.0.0:80 0.0.0.0:*")).toEqual(["unknown"]);
    });

    it("is empty when nothing listens, and ignores a stray MOTD line", () => {
        expect(readPortHolders("")).toEqual([]);
        expect(readPortHolders("Welcome to Ubuntu\n")).toEqual([]);
    });

    it("offers to free web servers only", () => {
        expect(holdersCanBeFreed(["nginx"])).toBe(true);
        expect(holdersCanBeFreed(["apache2", "caddy"])).toBe(true);
        expect(holdersCanBeFreed(["nginx", "someones-proxy"])).toBe(false);
        expect(holdersCanBeFreed(["unknown"])).toBe(false);
        expect(holdersCanBeFreed([])).toBe(false);
    });
});
