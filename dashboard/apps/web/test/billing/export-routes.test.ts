/**
 * Who may take a statement away as a file.
 *
 * The instance's statement names every owner's projects and what each spent, so
 * it is an administrator's; an organization's is for whoever holds its settings,
 * and an organization somebody may not read answers exactly as one that does not
 * exist. What is pinned here is the gate and what a permitted caller gets: the
 * file, named for its month, and a line in the audit trail saying a copy left.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const apiAdmin = vi.fn();
const apiUser = vi.fn();
const orgReaderWith = vi.fn();
const recordAudit = vi.fn(async () => undefined);
const readStatement = vi.fn();

class BillingRequestError extends Error {}

vi.mock("@/lib/api-session", () => ({ apiAdmin, apiUser }));
vi.mock("@/lib/orgs/activity-access", () => ({ orgReaderWith }));
vi.mock("@/lib/audit-service", () => ({ recordAudit }));
vi.mock("@/lib/billing/budgets", () => ({
    budgetsIn: async () => new Map(),
    getOrgBudget: async () => null
}));
vi.mock("@/lib/billing/statement", () => ({
    BillingRequestError,
    readStatement,
    resolveMonth: (month: string | undefined) => {
        if (month === "1999-01")
            throw new BillingRequestError("No figures are kept for that month");
        return month ?? "2026-09";
    }
}));

const adminExport = await import("../../src/app/api/admin/billing/export/route");
const adminRead = await import("../../src/app/api/admin/billing/route");
const orgExport = await import("../../src/app/api/orgs/[slug]/billing/export/route");
const orgRead = await import("../../src/app/api/orgs/[slug]/billing/route");

const OWNER = { kind: "org", id: "o1", name: "=Acme", handle: "acme" } as const;
const USAGE = {
    cpuHours: 12.5,
    memoryGbHours: 100,
    storageGbHours: 720,
    egressGb: 3,
    cpuUnmeasuredHours: 0
};

/** A statement with one line, the shape `readStatement` answers with. */
function view(month: string) {
    return {
        statement: {
            month,
            rates: {
                currency: "EUR",
                cpuHour: 0.02,
                memoryGbHour: null,
                storageGbMonth: 0.1,
                egressGb: null
            },
            lines: [
                {
                    projectId: "p1",
                    projectName: '=HYPERLINK("x")',
                    owner: OWNER,
                    usage: USAGE,
                    cost: { cpu: 0.25, memory: null, storage: 0.1, egress: null, total: 0.35 }
                }
            ],
            owners: [],
            usage: USAGE,
            cost: { cpu: 0.25, memory: null, storage: 0.1, egress: null, total: 0.35 }
        },
        monthLabel: "September 2026",
        months: [month],
        current: true,
        through: "2026-09-10T12:00:00.000Z",
        keptFrom: null,
        generatedAt: "2026-09-10T12:00:00.000Z"
    };
}

const forbidden = () =>
    new Response(JSON.stringify({ error: "You do not have access to that" }), { status: 403 });
const signedOut = () =>
    new Response(JSON.stringify({ error: "Sign in to continue" }), { status: 401 });
const slug = (value: string) => ({ params: Promise.resolve({ slug: value }) });

beforeEach(() => {
    apiAdmin.mockReset();
    apiUser.mockReset();
    orgReaderWith.mockReset();
    recordAudit.mockClear();
    readStatement.mockReset();
    readStatement.mockImplementation(async (_scope: unknown, month: string) => view(month));
});

describe("the instance's statement", () => {
    it("is refused to somebody who is not an administrator, before anything is read", async () => {
        apiAdmin.mockResolvedValue(forbidden());
        const answer = await adminExport.GET(
            new Request("http://localhost/api/admin/billing/export?month=2026-09")
        );
        expect(answer.status).toBe(403);
        expect(readStatement).not.toHaveBeenCalled();
        expect(recordAudit).not.toHaveBeenCalled();

        const read = await adminRead.GET(
            new Request("http://localhost/api/admin/billing?month=2026-09")
        );
        expect(read.status).toBe(403);
    });

    it("is refused to nobody signed in", async () => {
        apiAdmin.mockResolvedValue(signedOut());
        const answer = await adminExport.GET(
            new Request("http://localhost/api/admin/billing/export")
        );
        expect(answer.status).toBe(401);
    });

    it("hands an administrator the month as CSV, guarded, and records that a copy was taken", async () => {
        apiAdmin.mockResolvedValue({ id: "admin1", isAdmin: true });
        const answer = await adminExport.GET(
            new Request("http://localhost/api/admin/billing/export?month=2026-09&format=csv")
        );
        expect(answer.status).toBe(200);
        expect(answer.headers.get("content-type")).toContain("text/csv");
        expect(answer.headers.get("content-disposition")).toBe(
            'attachment; filename="polaris-statement-2026-09.csv"'
        );
        expect(readStatement).toHaveBeenCalledWith({ kind: "all" }, "2026-09");

        const [header, row] = (await answer.text()).split("\r\n");
        expect(header).toContain("project_id,project,cpu_vcpu_hours");
        // A name somebody typed that starts with `=` is text, not a formula.
        expect(row).toContain("'=Acme");
        expect(row).toContain('"\'=HYPERLINK(""x"")"');
        expect(row).toContain("12.5000,100.0000,1.0000,3.0000,EUR,0.25,,0.10,,0.35");

        expect(recordAudit).toHaveBeenCalledWith(
            expect.objectContaining({ actorId: "admin1", action: "billing.export" })
        );
    });

    it("hands the whole statement as JSON when asked", async () => {
        apiAdmin.mockResolvedValue({ id: "admin1", isAdmin: true });
        const answer = await adminExport.GET(
            new Request("http://localhost/api/admin/billing/export?month=2026-09&format=json")
        );
        expect(answer.headers.get("content-type")).toContain("application/json");
        const body = (await answer.json()) as { statement: { lines: unknown[] } };
        expect(body.statement.lines).toHaveLength(1);
    });

    it("refuses a month nothing is kept for, and a format it does not write", async () => {
        apiAdmin.mockResolvedValue({ id: "admin1", isAdmin: true });
        const old = await adminExport.GET(
            new Request("http://localhost/api/admin/billing/export?month=1999-01")
        );
        expect(old.status).toBe(400);
        const odd = await adminExport.GET(
            new Request("http://localhost/api/admin/billing/export?format=xlsx")
        );
        expect(odd.status).toBe(400);
        expect(recordAudit).not.toHaveBeenCalled();
    });
});

describe("an organization's statement", () => {
    it("answers somebody without the organization's settings as if it did not exist", async () => {
        apiUser.mockResolvedValue({ id: "u1", isAdmin: false });
        orgReaderWith.mockResolvedValue(null);
        const answer = await orgExport.GET(
            new Request("http://localhost/api/orgs/acme/billing/export?month=2026-09"),
            slug("acme")
        );
        expect(answer.status).toBe(404);
        expect(orgReaderWith).toHaveBeenCalledWith(
            { id: "u1", isAdmin: false },
            "acme",
            "settings.manage"
        );
        expect(readStatement).not.toHaveBeenCalled();

        const read = await orgRead.GET(
            new Request("http://localhost/api/orgs/acme/billing"),
            slug("acme")
        );
        expect(read.status).toBe(404);
    });

    it("is refused to nobody signed in", async () => {
        apiUser.mockResolvedValue(signedOut());
        const answer = await orgExport.GET(
            new Request("http://localhost/api/orgs/acme/billing/export"),
            slug("acme")
        );
        expect(answer.status).toBe(401);
        expect(orgReaderWith).not.toHaveBeenCalled();
    });

    it("covers only that organization, and is written into its own history", async () => {
        apiUser.mockResolvedValue({ id: "u1", isAdmin: false });
        orgReaderWith.mockResolvedValue("o1");
        const answer = await orgExport.GET(
            new Request("http://localhost/api/orgs/acme/billing/export?month=2026-09&format=csv"),
            slug("acme")
        );
        expect(answer.status).toBe(200);
        expect(answer.headers.get("content-disposition")).toBe(
            'attachment; filename="acme-statement-2026-09.csv"'
        );
        expect(readStatement).toHaveBeenCalledWith({ kind: "orgs", orgIds: ["o1"] }, "2026-09");
        expect(recordAudit).toHaveBeenCalledWith(
            expect.objectContaining({ actorId: "u1", orgId: "o1", action: "billing.export" })
        );
    });
});
