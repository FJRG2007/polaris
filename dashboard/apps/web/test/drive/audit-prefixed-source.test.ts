/**
 * Auditing what somebody did inside a source whose id is not a uuid.
 *
 * `AuditLog.targetId` is a uuid column, and two of Drive's sources are not
 * addressed by one: a deployed service's filesystem is `container:<id>` and a
 * registered server is `host:<id>`. Prisma refuses a value like that rather than
 * storing it, and the audit write is deliberately swallowed so a failed record
 * never fails somebody's action - which together meant every new folder, rename
 * and delete inside a game server's own files went unrecorded, silently. That is
 * the one outcome an audit log may not have.
 *
 * So the id moves into the metadata, and the column is left empty. What is pinned
 * here is that a uuid still lands in the column (every other caller depends on
 * it) and that a prefixed source is written down somewhere at all.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const create = vi.fn(async () => ({}));

vi.mock("@polaris/db", () => ({ prisma: { auditLog: { create } } }));
vi.mock("@/lib/auth", () => ({ auth: { api: { getSession: async () => null } } }));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("@/lib/request-context", () => ({ clientIp: () => null }));
vi.mock("@/lib/notifications/security-events", () => ({ notifySecurityChange: async () => undefined }));

const { recordAudit } = await import("@/lib/audit-service");

/** What the row would have been written with. */
function written(): { targetId: string | null; metadata: string | null } {
    return create.mock.calls[0]?.[0]?.data as { targetId: string | null; metadata: string | null };
}

beforeEach(() => {
    create.mockClear();
});

describe("recording an action against a drive source", () => {
    it("keeps a uuid in the column it belongs in", async () => {
        const id = "6f1a2b3c-4d5e-4f60-8a9b-0c1d2e3f4a5b";
        await recordAudit({ actorId: null, action: "drive.mkdir", targetType: "connection", targetId: id });

        expect(written().targetId).toBe(id);
        expect(written().metadata).toBeNull();
    });

    it("writes a container's id down rather than losing the row", async () => {
        await recordAudit({
            actorId: null,
            action: "drive.mkdir",
            targetType: "connection",
            targetId: "container:9a7c1e12-0000-4000-8000-000000000000",
            metadata: { path: "data/config" }
        });

        expect(written().targetId).toBeNull();
        const meta = JSON.parse(written().metadata ?? "{}") as { target?: string; path?: string };
        expect(meta.target).toBe("container:9a7c1e12-0000-4000-8000-000000000000");
        // And what the action was about survives beside it.
        expect(meta.path).toBe("data/config");
    });

    it("does the same for a registered server", async () => {
        await recordAudit({
            actorId: null,
            action: "drive.delete",
            targetType: "connection",
            targetId: "host:9a7c1e12-0000-4000-8000-000000000000"
        });

        expect(written().targetId).toBeNull();
        expect(JSON.parse(written().metadata ?? "{}").target).toBe(
            "host:9a7c1e12-0000-4000-8000-000000000000"
        );
    });

    it("leaves a row that names no target alone", async () => {
        await recordAudit({ actorId: null, action: "drive.read" });

        expect(written().targetId).toBeNull();
        expect(written().metadata).toBeNull();
    });
});
