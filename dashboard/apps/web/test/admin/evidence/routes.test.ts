/**
 * The two evidence endpoints answer administrators only, and a refused caller
 * gets nothing read and nothing recorded. An export writes its hash into the
 * audit trail, and it is the hash of the JSON the caller receives.
 */

import { readings } from "./fixtures";
import { NextResponse } from "next/server";
import { buildEvidence } from "@/lib/compliance/evidence";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { evidenceDigest } from "@/lib/compliance/evidence-export";

const apiAdmin = vi.fn(async (): Promise<unknown> => ({ id: "admin-1", isAdmin: true }));
const readEvidence = vi.fn(async () => buildEvidence(readings()));
const recordAudit = vi.fn(async () => undefined);

vi.mock("@/lib/api-session", () => ({ apiAdmin }));
vi.mock("@/lib/compliance/evidence-readings", () => ({ readEvidence }));
vi.mock("@/lib/audit-service", () => ({ recordAudit }));

const view = await import("../../../src/app/api/admin/evidence/route");
const exporter = await import("../../../src/app/api/admin/evidence/export/route");

const refusals = [
    ["signed out", 401, "Sign in to continue"],
    ["not an administrator", 403, "You do not have access to that"]
] as const;

describe("the evidence endpoints", () => {
    beforeEach(() => {
        apiAdmin.mockReset();
        apiAdmin.mockResolvedValue({ id: "admin-1", isAdmin: true });
        readEvidence.mockClear();
        recordAudit.mockClear();
    });

    for (const [who, status, error] of refusals) {
        it(`refuses somebody ${who}, reading and recording nothing`, async () => {
            apiAdmin.mockResolvedValue(NextResponse.json({ error }, { status }));
            const [read, exported] = [await view.GET(), await exporter.POST()];
            expect(read.status).toBe(status);
            expect(exported.status).toBe(status);
            expect(readEvidence).not.toHaveBeenCalled();
            expect(recordAudit).not.toHaveBeenCalled();
        });
    }

    it("shows an administrator the report without recording a reading", async () => {
        const answer = await view.GET();
        expect(answer.status).toBe(200);
        expect(answer.headers.get("cache-control")).toBe("private, no-store");
        const body = (await answer.json()) as { sections: unknown[] };
        expect(body.sections.length).toBeGreaterThan(0);
        expect(recordAudit).not.toHaveBeenCalled();
    });

    it("exports both files and records the JSON's hash with who took it", async () => {
        const answer = await exporter.POST();
        expect(answer.status).toBe(200);
        const body = (await answer.json()) as {
            sha256: string;
            json: { body: string };
            markdown: { body: string };
        };
        expect(evidenceDigest(body.json.body)).toBe(body.sha256);
        expect(body.markdown.body).toContain(body.sha256);
        expect(recordAudit).toHaveBeenCalledTimes(1);
        expect(recordAudit).toHaveBeenCalledWith(
            expect.objectContaining({
                actorId: "admin-1",
                action: "evidence.export",
                metadata: expect.objectContaining({ sha256: body.sha256 })
            })
        );
    });

    it("answers a failed read with a sentence rather than the failure", async () => {
        const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
        readEvidence.mockRejectedValueOnce(new Error("connection refused at 10.0.0.5"));
        const answer = await exporter.POST();
        expect(answer.status).toBe(500);
        const body = (await answer.json()) as { error: string };
        expect(body.error).not.toContain("10.0.0.5");
        expect(recordAudit).not.toHaveBeenCalled();
        spy.mockRestore();
    });
});
