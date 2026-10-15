/**
 * An import refused for something in the backup keeps the refusal as its code,
 * and the reader sees it in their own words; a code this server has no words
 * for gets the general sentence. The database is a fake.
 */

import { describe, expect, it, vi } from "vitest";

const OWNER = "00000000-0000-7000-8000-0000000000aa";

let stored: string | null = null;

const row = () => ({
    id: "00000000-0000-7000-8000-0000000000bb",
    status: "failed",
    step: "unpacking",
    done: 0,
    total: 0,
    projectId: null,
    result: null,
    error: stored,
    startedAt: new Date(),
    updatedAt: new Date()
});

vi.mock("@polaris/db", () => ({
    prisma: { deployImport: { findFirst: async () => row(), findMany: async () => [row()] } }
}));
vi.mock("@/lib/deploy-audit", () => ({ recordDeployAudit: async () => undefined }));

const jobs = await import("@/lib/deploy/panel-import/jobs");

describe("an import's refusal", () => {
    it("is worded from its code", async () => {
        stored = "absolutePath";
        expect((await jobs.getImport(row().id, OWNER))?.error).toBe("The backup contains an absolute path.");
    });

    it("fills in the limit it names", async () => {
        stored = "tooLarge";
        expect((await jobs.recentImports(OWNER))[0]?.error).toBe("The backup unpacks to more than 20 GB.");
    });

    it("falls back to the general sentence for a code it does not know", async () => {
        stored = "somethingNewer";
        expect((await jobs.getImport(row().id, OWNER))?.error).toBeNull();
    });
});
