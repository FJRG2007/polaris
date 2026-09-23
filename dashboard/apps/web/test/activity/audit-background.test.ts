/**
 * An audit entry written by background work is written.
 *
 * The push poller, a cron tick and the autoscaler run outside any request, and
 * asking for the caller's address there throws. That throw happened inside the
 * audit write and was swallowed with it, so everything they did went unrecorded.
 * Here `next/headers` is the real one, outside a request - exactly that case.
 */

import { beforeEach, expect, it, vi } from "vitest";

const { create } = vi.hoisted(() => ({ create: vi.fn(async () => ({})) }));

vi.mock("@polaris/db", () => ({ prisma: { auditLog: { create } } }));
vi.mock("@/lib/auth", () => ({ auth: { api: { getSession: vi.fn(async () => null) } } }));
vi.mock("@/lib/notifications/security-events", () => ({ notifySecurityChange: vi.fn(async () => undefined) }));

const { recordAudit } = await import("@/lib/audit-service");

beforeEach(() => create.mockClear());

// A real one, because the column it lands in is a uuid: a fixture id like
// "app-1" is recorded in the entry's metadata instead, which is a different
// path and has its own test (`audit-prefixed-source`).
const APPLICATION = "3f1d2c4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f";

it("records what background work did, with no address to hash", async () => {
    await recordAudit({
        actorId: "owner-1",
        action: "deploy.app.deploy",
        targetType: "application",
        targetId: APPLICATION
    });
    expect(create).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith({
        data: expect.objectContaining({
            action: "deploy.app.deploy",
            targetId: APPLICATION,
            ipHash: undefined,
            sessionId: undefined
        })
    });
});
