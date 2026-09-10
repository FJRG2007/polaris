/**
 * A service's port is closed unless the way it was made needs it open.
 *
 * `createApplication` has no default for `publishPort`, so the compiler makes
 * every caller choose. What it cannot check is that each one chose right: a
 * cloned environment used to fall back to "open" and bring up, on the machine's
 * own address, a service whose original was reached only through the edge.
 */

import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const SRC = new URL("../../src/", import.meta.url);
const read = (path: string) => readFile(new URL(path, SRC), "utf8");

describe("the port a new service publishes", () => {
    it("has no default to fall back on", async () => {
        const service = await read("lib/deploy-service.ts");
        expect(service).toContain("    publishPort: boolean;");
        expect(service).toContain("publishPort: input.publishPort,");
        expect(service).not.toContain("input.publishPort ?? true");
    });

    it("is closed for what somebody deploys, migrates or adds from a template", async () => {
        expect(await read("app/(app)/apps/deploy/actions.ts")).toContain("publishPort: false");
        expect(await read("lib/deploy/migrate.ts")).toContain("publishPort: false");
        expect(await read("lib/deploy/template-setup.ts")).toContain("publishPort: false");
    });

    it("follows the original in a cloned environment", async () => {
        expect(await read("lib/deploy/environments.ts")).toContain("publishPort: application.publishPort");
    });

    it("starts what somebody deploys with the headers any app survives", async () => {
        // Production defaults for a new service: HSTS, nosniff, a sane referrer,
        // same-site framing. Existing services keep theirs; catalog apps and the
        // templates that another page may embed start with none.
        const service = await read("lib/deploy-service.ts");
        expect(service).toContain('edgeConfig: JSON.stringify({ headers: { preset: "recommended" } })');
        expect(await read("app/(app)/apps/deploy/actions.ts")).toContain("safeHeaders: !template?.embedded");
        expect(await read("lib/deploy/template-setup.ts")).toContain("safeHeaders: true");
        expect(await read("lib/deploy/migrate.ts")).toContain("safeHeaders: true");
    });

    it("is open only where the host port is how it is reached", async () => {
        // A catalog install (a game server's clients type that port) and the mail
        // server Polaris manages over it.
        expect(await read("lib/apps/install-service.ts")).toContain("publishPort: true");
        expect(await read("lib/mail-server/setup.ts")).toContain("publishPort: true");
    });
});
