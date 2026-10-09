/**
 * A view's filter, a group of a grouped list and a board's order, as the
 * database is asked for them.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("@polaris/db", () => ({ prisma: {}, Prisma: { Decimal: class {} } }));

import { filterWhere } from "@polaris-app/crm/src/lib/filters";
import { listOrder, listWhere } from "@polaris-app/crm/src/lib/query";

const shelf = { orgId: "o1", userId: null, key: "org:o1", orgName: "Acme" };
const rule = (key: string, operator: string, value: unknown) => ({ id: key, key, operator, value }) as never;
const insensitive = (text: string) => ({ contains: text, mode: "insensitive" });

describe("filterWhere", () => {
    it("narrows nothing without whole rules", () => {
        expect(filterWhere("companies", { conjunction: "and", rules: [] })).toEqual({});
        expect(
            filterWhere("companies", { conjunction: "and", rules: [rule("city", "contains", "")] })
        ).toEqual({});
    });

    it("joins rules and groups the way each one says", () => {
        const where = filterWhere("opportunities", {
            conjunction: "and",
            rules: [
                rule("stage", "isAnyOf", [{ id: "proposal", name: "" }]),
                {
                    id: "g",
                    conjunction: "or",
                    rules: [rule("amount", "greaterThan", 10000), rule("owner", "isEmpty", null)]
                }
            ]
        } as never);
        expect(where).toEqual({
            AND: [
                { stage: { in: ["proposal"] } },
                { OR: [{ amount: { gt: 10000 } }, { ownerId: null }] }
            ]
        });
    });

    it("reads a person's name in both its parts, every word somewhere", () => {
        expect(
            filterWhere("people", { conjunction: "and", rules: [rule("name", "contains", "ana gar")] })
        ).toEqual({
            AND: [
                { OR: [{ firstName: insensitive("ana") }, { lastName: insensitive("ana") }] },
                { OR: [{ firstName: insensitive("gar") }, { lastName: insensitive("gar") }] }
            ]
        });
    });

    it("counts a record pointing at nothing as none of the chosen ones", () => {
        expect(
            filterWhere("people", {
                conjunction: "and",
                rules: [rule("company", "isNoneOf", [{ id: "c1", name: "Acme" }])]
            })
        ).toEqual({ OR: [{ companyId: null }, { companyId: { notIn: ["c1"] } }] });
    });

    it("compares a count with whole numbers only", () => {
        const where = (operator: string, value: number) =>
            filterWhere("companies", { conjunction: "and", rules: [rule("employees", operator, value)] });
        expect(where("greaterThan", 2.5)).toEqual({ employees: { gt: 2 } });
        expect(where("lessThan", 2.5)).toEqual({ employees: { lt: 3 } });
        expect(where("is", 2.5)).toEqual({ id: { in: [] } });
        expect(where("is", 10)).toEqual({ employees: 10 });
    });

    it("reads days as whole UTC days", () => {
        const created = filterWhere("companies", {
            conjunction: "and",
            rules: [rule("createdAt", "is", "2026-10-09")]
        });
        expect(created).toEqual({
            createdAt: {
                gte: new Date("2026-10-09T00:00:00.000Z"),
                lt: new Date("2026-10-10T00:00:00.000Z")
            }
        });
        expect(
            filterWhere("opportunities", {
                conjunction: "and",
                rules: [rule("closeDate", "after", "2026-10-09")]
            })
        ).toEqual({ closeDate: { gt: new Date("2026-10-09T00:00:00.000Z") } });
    });
});

describe("listWhere and listOrder", () => {
    it("puts the search, the filter and the group side by side", () => {
        const where = listWhere("opportunities", shelf, {
            search: "deal",
            filter: { conjunction: "and", rules: [rule("amount", "isEmpty", null)] },
            group: { key: "stage", value: "new" }
        });
        expect(where).toEqual({
            orgId: "o1",
            deletedAt: null,
            AND: [
                { AND: [{ OR: [{ name: insensitive("deal") }] }] },
                { amount: null },
                { stage: "new" }
            ]
        });
    });

    it("orders a board with no sorts by where its cards were put", () => {
        expect(listOrder("opportunities", [], true)).toEqual([
            { position: "asc" },
            { createdAt: "desc" },
            { id: "desc" }
        ]);
        expect(listOrder("opportunities", [{ key: "name", direction: "asc" }], true)[0]).toEqual({
            name: "asc"
        });
    });
});
