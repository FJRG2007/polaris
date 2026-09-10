/**
 * What the trail keeps when a backup plan is saved: whether it was made or
 * changed, and everything that decides where its copies go and how long they
 * stay.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const recordAudit = vi.fn(async (_event: Record<string, unknown>) => undefined);
const savePlan = vi.fn(async () => ({ id: "00000000-0000-4000-8000-0000000000a1" }));

vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("@/lib/session", () => ({ requireAdmin: async () => ({ id: "admin-1" }) }));
vi.mock("@/lib/backups/manage", () => ({ savePlan }));
vi.mock("@/lib/backups/keyring", () => ({}));
vi.mock("@/lib/audit-service", () => ({ recordAudit }));
vi.mock("@/lib/backups/service", () => ({ runBackup: async () => undefined }));

const { savePlanAction } = await import("@/app/(app)/apps/backups/actions");

const DESTINATIONS = [
    "00000000-0000-4000-8000-0000000000d1",
    "00000000-0000-4000-8000-0000000000d2"
];
const PLAN = {
    name: "Nightly",
    every: "daily",
    keepLast: 7,
    keepDays: 30,
    maxBytes: 1024 ** 3,
    notifyOnFailure: true,
    destinationIds: DESTINATIONS
};

beforeEach(() => {
    recordAudit.mockClear();
    savePlan.mockClear();
});

describe("saving a backup plan", () => {
    it("records a new plan as made, with its destinations and its size budget", async () => {
        await savePlanAction(PLAN);
        expect(recordAudit).toHaveBeenCalledWith(
            expect.objectContaining({
                action: "backup.plan.save",
                metadata: {
                    mode: "create",
                    every: "daily",
                    keepLast: 7,
                    keepDays: 30,
                    maxBytes: 1024 ** 3,
                    destinationIds: DESTINATIONS
                }
            })
        );
    });

    it("records an existing plan as changed", async () => {
        await savePlanAction(PLAN, "00000000-0000-4000-8000-0000000000a1");
        const metadata = recordAudit.mock.calls[0]?.[0]?.metadata as
            | Record<string, unknown>
            | undefined;
        expect(metadata?.mode).toBe("update");
    });
});
