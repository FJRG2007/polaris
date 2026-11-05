import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/backups/sealing", () => ({}));

describe("instance transfer carries badges", () => {
    it("does not leave badge tables behind", async () => {
        const { LEFT_BEHIND } = await import("@/lib/instance-transfer/transfer");
        const { Prisma } = await import("@polaris/db");
        const names = Prisma.dmmf.datamodel.models.map((model) => model.name);
        for (const table of [
            "BadgeDefinition",
            "BadgeGrant",
            "BadgeUnlock",
            "BadgePreference",
            "UserPrivacy"
        ]) {
            expect(names).toContain(table);
            expect(LEFT_BEHIND.has(table)).toBe(false);
        }
    });
});
