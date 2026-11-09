/**
 * Storing the ready-made policies.
 *
 * They are created when missing, rewritten when an update changed one, left
 * alone otherwise, and a row somebody made under the reserved prefix before it
 * was reserved is taken over rather than duplicated.
 */

import { vi } from "vitest";
import { beforeEach, describe, expect, it } from "vitest";

type Row = { id: string; name: string; document: string; isSystem: boolean };
let rows: Row[] = [];
let writes = 0;

vi.mock("@polaris/db", () => ({
    prisma: {
        policy: {
            findMany: async ({ where }: { where: { name: { in: string[] } } }) =>
                rows.filter((row) => where.name.in.includes(row.name)).map((row) => ({ ...row })),
            findUnique: async ({ where }: { where: { id: string } }) => rows.find((row) => row.id === where.id) ?? null,
            create: async ({ data }: { data: Omit<Row, "id"> }) => {
                if (rows.some((row) => row.name === data.name)) throw new Error("unique");
                writes += 1;
                const row = { id: `p${rows.length + 1}`, ...data };
                rows.push(row);
                return { id: row.id };
            },
            update: async ({ where, data }: { where: { id: string }; data: Partial<Row> }) => {
                writes += 1;
                const row = rows.find((entry) => entry.id === where.id);
                if (row) Object.assign(row, data);
                return row;
            }
        }
    }
}));
vi.mock("../../src/groups.js", () => ({ getUserGroupIds: async () => [] }));

const { syncPolicyTemplates, createPolicy, updatePolicy } = await import("../../src/policies.js");
const { POLICY_TEMPLATES, policyTemplateName } = await import("@polaris/core");

beforeEach(() => {
    rows = [];
    writes = 0;
});

describe("syncPolicyTemplates", () => {
    it("creates every template once, as a system policy", async () => {
        expect(await syncPolicyTemplates()).toBe(true);
        expect(rows).toHaveLength(POLICY_TEMPLATES.length);
        expect(rows.every((row) => row.isSystem)).toBe(true);
        writes = 0;
        expect(await syncPolicyTemplates()).toBe(false);
        expect(writes).toBe(0);
    });

    it("rewrites a template an update changed, and takes over a look-alike", async () => {
        await syncPolicyTemplates();
        const driveUser = rows.find((row) => row.name === policyTemplateName("drive-user"));
        if (!driveUser) throw new Error("missing");
        driveUser.document = JSON.stringify({ statements: [{ effect: "allow", actions: ["*"], resources: ["*"] }] });
        driveUser.isSystem = false;
        expect(await syncPolicyTemplates()).toBe(true);
        expect(driveUser.isSystem).toBe(true);
        expect(JSON.parse(driveUser.document).statements).toEqual(
            JSON.parse(JSON.stringify(POLICY_TEMPLATES.find((entry) => entry.key === "drive-user")?.statements))
        );
    });
});

describe("the reserved prefix", () => {
    it("cannot be used to make or rename a policy into a template", async () => {
        const document = { statements: [{ effect: "allow", actions: ["drive.read"], resources: ["*"] }] };
        await expect(createPolicy("polaris:drive-user", undefined, document)).rejects.toThrow();
        rows.push({ id: "own", name: "Mine", document: JSON.stringify(document), isSystem: false });
        await expect(updatePolicy("own", { name: "polaris:read-only" })).rejects.toThrow();
    });
});
