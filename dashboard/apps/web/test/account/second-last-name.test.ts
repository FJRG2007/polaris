/**
 * The second surname is stored like the other two halves of a name: normalized
 * on the server, empty stored as null, and left alone when a save does not send
 * it - so a screen that predates the field never clears one somebody set.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const writes: Array<Record<string, unknown>> = [];

vi.mock("@polaris/db", () => ({
    prisma: {
        user: {
            findUnique: async () => ({ id: "ana", username: "ana", usernameChangedAt: null }),
            findFirst: async () => null,
            update: async ({ data }: { data: Record<string, unknown> }) => {
                writes.push(data);
                return data;
            }
        },
        account: { findFirst: async () => null }
    }
}));

const { updateUserProfile } = await import("@polaris/auth");

beforeEach(() => {
    writes.length = 0;
});

describe("saving a second surname", () => {
    it("normalizes it the way the other halves are", async () => {
        const result = await updateUserProfile("ana", {
            firstName: "  javier ",
            lastName: "romero",
            secondLastName: "  gonzález   pérez "
        });
        expect(result.error).toBeUndefined();
        expect(writes[0]).toMatchObject({
            firstName: "Javier",
            lastName: "Romero",
            secondLastName: "González Pérez"
        });
    });

    it("stores a cleared one as null", async () => {
        await updateUserProfile("ana", { secondLastName: "   " });
        expect(writes[0]?.secondLastName).toBeNull();
    });

    it("leaves it untouched when the save does not send it", async () => {
        await updateUserProfile("ana", { firstName: "Javier", lastName: "Romero González" });
        expect(writes[0]).not.toHaveProperty("secondLastName");
        // The stored surname is kept exactly as typed - nothing splits it.
        expect(writes[0]?.lastName).toBe("Romero González");
    });

    it("refuses one that is too long", async () => {
        const result = await updateUserProfile("ana", { secondLastName: "a".repeat(121) });
        expect(result.error).toBeTruthy();
        expect(writes).toHaveLength(0);
    });
});
