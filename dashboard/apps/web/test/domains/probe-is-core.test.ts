/**
 * The health probe, and the route repair it carries, is infrastructure.
 *
 * An unrouted address is the one edge outage Polaris ends on its own, so the
 * probe that notices it has to run on every install - whether Watch was ever set
 * up, retired, or replaced by Automations. These read the sources rather than
 * importing the job table, which pulls in most of the control plane.
 */

import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const SRC = new URL("../../src/", import.meta.url);

async function source(path: string): Promise<string> {
    return readFile(new URL(path, SRC), "utf8");
}

describe("the domain health probe", () => {
    it("imports nothing from Watch or Automations", async () => {
        const probe = await source("lib/domain-health-probe.ts");
        const imports = [...probe.matchAll(/from "([^"]+)"/g)].map((match) => match[1]!);
        expect(imports.length).toBeGreaterThan(0);
        for (const path of imports) {
            expect(path).not.toMatch(/watch|automations/);
        }
        // The repair itself is still there, reached lazily.
        expect(probe).toContain('await import("@/lib/deploy-service")');
        expect(probe).toContain("syncAppRoutes({ force: true })");
    });

    it("runs as the leased core domain-health job", async () => {
        const jobs = await source("lib/cron/jobs.ts");
        expect(jobs).toContain('import { probeAllDomains } from "@/lib/domain-health-probe";');
        const start = jobs.indexOf('key: "domain-health"');
        expect(start).toBeGreaterThan(-1);
        const block = jobs.slice(start, jobs.indexOf("}", start));
        expect(block).toMatch(/leaseMs: 5 \* MINUTE/);
        expect(block).toContain("run: probeAllDomains");
    });
});
