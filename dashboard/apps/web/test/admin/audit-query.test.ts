/**
 * Reading the audit trail through a scope that no filter can widen, and taking it
 * away as a file that cannot run anything when opened.
 *
 * The scope is decided by the route that authorized the caller; the filters come
 * from the request. What must hold is that the second can only ever narrow the
 * first - an organization's reader naming another organization's person, or an
 * account naming somebody else as the actor, still sees only their own scope.
 */

import { describe, expect, it, vi } from "vitest";

let lastWhere: unknown = null;
let rows: {
    id: string;
    at: Date;
    actorId: string | null;
    action: string;
    targetType: string | null;
    targetId: string | null;
    metadata: string | null;
    sessionId: string | null;
    orgId: string | null;
    seq: bigint | null;
    hash: string | null;
}[] = [];

vi.mock("@polaris/db", () => ({
    prisma: {
        auditLog: {
            findMany: async ({ where, take }: { where: unknown; take: number }) => {
                lastWhere = where;
                return rows.slice(0, take);
            },
            count: async () => rows.length,
            groupBy: async () => []
        },
        user: { findMany: async () => [{ id: "u1", name: "Ana", username: "ana" }] }
    }
}));

vi.mock("@/lib/audit-chain", () => ({
    auditChainStatus: async () => ({ head: { seq: "7", hash: "a".repeat(64) }, checkpoint: null })
}));

const { auditWhere, queryAudit, streamAuditExport } = await import("@/lib/audit-query");
const core = await import("@polaris/core");

function filter(input: Record<string, string> = {}): core.AuditFilter {
    const parsed = core.auditFilterSchema.safeParse(input);
    if (!parsed.success) throw new Error(parsed.error.issues[0]?.message);
    return parsed.data;
}

const ACTOR = "018f0000-0000-7000-8000-000000000001";

describe("the scope a filter cannot widen", () => {
    it("keeps an organization's reader inside the organization whoever they name", () => {
        const where = auditWhere({ kind: "org", orgId: "org-1" }, filter({ actor: ACTOR }));
        expect(where).toEqual({ AND: [{ orgId: "org-1" }, { actorId: ACTOR }] });
    });

    it("ignores an actor filter on somebody's own history rather than letting it name another", () => {
        const where = auditWhere({ kind: "user", userId: "me" }, filter({ actor: ACTOR }));
        expect(where).toEqual({ AND: [{ actorId: "me" }] });
    });

    it("narrows an area by its first segment and never by a prefix of a longer word", () => {
        const where = auditWhere({ kind: "all" }, filter({ area: "org" })) as {
            AND: unknown[];
        };
        expect(where.AND).toEqual([
            { OR: [{ action: "org" }, { action: { startsWith: "org." } }] }
        ]);
    });

    it("pages by position, newest first, without an offset", () => {
        const cursor = core.encodeAuditCursor(new Date(1_757_000_000_000), ACTOR);
        const where = auditWhere({ kind: "all" }, filter({ cursor })) as { AND: unknown[] };
        expect(where.AND).toEqual([
            {
                OR: [
                    { at: { lt: new Date(1_757_000_000_000) } },
                    { at: new Date(1_757_000_000_000), id: { lt: ACTOR } }
                ]
            }
        ]);
    });
});

describe("the narrowing a request may ask for", () => {
    it("refuses a range whose end is before its start", () => {
        const parsed = core.auditFilterSchema.safeParse({
            from: "2026-09-02T00:00:00.000Z",
            to: "2026-09-01T00:00:00.000Z"
        });
        expect(parsed.success).toBe(false);
    });

    it("refuses anything that is not a page position", () => {
        expect(core.auditFilterSchema.safeParse({ cursor: "1; DROP TABLE" }).success).toBe(false);
        expect(core.decodeAuditCursor("not-a-cursor")).toBeNull();
    });

    it("caps a page, whatever is asked", () => {
        expect(core.auditFilterSchema.safeParse({ limit: "5000" }).success).toBe(false);
        expect(filter().limit).toBe(core.AUDIT_PAGE_DEFAULT);
    });
});

describe("a page", () => {
    it("says where the next one starts only when there is one", async () => {
        rows = Array.from({ length: 3 }, (_, index) => ({
            id: `018f0000-0000-7000-8000-00000000000${index}`,
            at: new Date(1_757_000_000_000 - index * 1000),
            actorId: index === 0 ? "u1" : index === 1 ? "gone" : null,
            action: "org.member.invite",
            targetType: "org",
            targetId: null,
            metadata: null,
            sessionId: null,
            orgId: "org-1",
            seq: BigInt(index + 1),
            hash: "b".repeat(64)
        }));
        const page = await queryAudit({ kind: "org", orgId: "org-1" }, filter({ limit: "2" }));
        expect(page.items).toHaveLength(2);
        expect(page.nextCursor).toBe(core.encodeAuditCursor(rows[1]!.at, rows[1]!.id));
        // Nobody is dropped for having left, and nothing signed in reads as Polaris.
        expect(page.items.map((item) => item.actorName)).toEqual(["Ana", "a former member"]);
        expect(lastWhere).toMatchObject({ AND: [{ orgId: "org-1" }] });
    });
});

describe("an export", () => {
    async function drain(stream: ReadableStream<Uint8Array>): Promise<string> {
        const reader = stream.getReader();
        const decoder = new TextDecoder();
        let out = "";
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            out += decoder.decode(value);
        }
        return out;
    }

    it("defuses a cell a spreadsheet would run as a formula", async () => {
        rows = [
            {
                id: "018f0000-0000-7000-8000-000000000009",
                at: new Date(1_757_000_000_000),
                actorId: "u1",
                action: "deploy.variable.set",
                targetType: "application",
                targetId: null,
                metadata: '=HYPERLINK("https://evil.example","x")',
                sessionId: null,
                orgId: null,
                seq: 1n,
                hash: "c".repeat(64)
            }
        ];
        const csv = await drain(
            streamAuditExport({ kind: "all" }, filter(), "csv", {
                scope: "all",
                total: 1,
                truncated: false
            })
        );
        const [header, line] = csv.trim().split("\r\n");
        expect(header?.startsWith("id,at,seq,actor_id,actor,action")).toBe(true);
        expect(line).toContain('"\'=HYPERLINK(""https://evil.example"",""x"")"');
    });

    it("opens a JSON export with the chain head, the anchor worth keeping elsewhere", async () => {
        const json = await drain(
            streamAuditExport({ kind: "all" }, filter(), "json", {
                scope: "all",
                total: 1,
                truncated: false
            })
        );
        const parsed = JSON.parse(json) as { chain: { head: { seq: string } }; entries: unknown[] };
        expect(parsed.chain.head.seq).toBe("7");
        expect(parsed.entries).toHaveLength(1);
    });
});
