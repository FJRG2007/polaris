import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/backups/sealing", () => ({}));

describe("instance transfer carries name tags", () => {
    it("carries member choices, organization tags and the instance tag", async () => {
        const { LEFT_BEHIND } = await import("@/lib/instance-transfer/transfer");
        const { Prisma } = await import("@polaris/db");
        const models = Prisma.dmmf.datamodel.models;
        for (const table of ["NameTagChoice", "Organization", "Setting"]) {
            expect(models.map((model) => model.name)).toContain(table);
            expect(LEFT_BEHIND.has(table)).toBe(false);
        }
        const org = models.find((model) => model.name === "Organization")!;
        const fields = org.fields.map((field) => field.name);
        for (const field of ["tagEnabled", "tagText", "tagEmblem", "tagColor"])
            expect(fields).toContain(field);
    });
});
