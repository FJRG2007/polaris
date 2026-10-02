/**
 * A new row, removing rows and a new table: the statements the grid and the
 * New table form turn into, and the requests they refuse.
 *
 * What is asserted is that nothing typed reaches statement text except a name
 * that passed the identifier rule (then quoted) or a default that passed the
 * literal rule (then quoted), and that a removal is aimed by whole primary keys.
 */

import { describe, expect, it } from "vitest";
import type { DataColumn } from "@/lib/data/driver";
import { rowDeleteSchema, tableDraftSchema } from "@/lib/data/row-edit-schema";
import { quoteBacktickIdent, quoteQualified, quoteSqlIdent } from "@polaris/core";
import {
    defaultLiteral,
    prepareCreateTable,
    prepareDelete,
    prepareInsert,
    type ColumnDraft,
    type TableDraft
} from "@/lib/data/row-edit";

const columns: DataColumn[] = [
    { name: "id", type: "bigint", nullable: false, primaryKey: true },
    { name: "email", type: "text", nullable: false, primaryKey: false },
    { name: "note", type: "text", nullable: true, primaryKey: false }
];

const pg = { quote: quoteSqlIdent, placeholder: (index: number) => `$${index}`, target: '"public"."users"' };
const my = { quote: quoteBacktickIdent, placeholder: () => "?", target: "`app`.`users`" };

function column(over: Partial<ColumnDraft>): ColumnDraft {
    return {
        name: "title",
        type: "text",
        nullable: true,
        primaryKey: false,
        unique: false,
        defaultValue: { kind: "none" },
        ...over
    };
}

function create(draft: Partial<TableDraft>, flavor: "postgres" | "mysql" = "postgres"): string {
    const full: TableDraft = { namespace: "public", name: "orders", columns: [column({})], ...draft };
    return flavor === "postgres"
        ? prepareCreateTable(full, "postgres", quoteSqlIdent, (namespace, name) => quoteQualified([namespace ?? "public", name], quoteSqlIdent))
        : prepareCreateTable(full, "mysql", quoteBacktickIdent, (namespace, name) => quoteQualified([namespace, name], quoteBacktickIdent));
}

describe("a new row", () => {
    it("binds every value and names only the columns given", () => {
        const prepared = prepareInsert(
            { namespace: "public", relation: "users", values: { email: "x'); DROP TABLE users; --", note: null } },
            columns,
            pg,
            "postgres"
        );
        expect(prepared.text).toBe('INSERT INTO "public"."users" ("email", "note") VALUES ($1, $2)');
        expect(prepared.params).toEqual(["x'); DROP TABLE users; --", null]);
    });

    it("takes every default when nothing is given", () => {
        expect(prepareInsert({ namespace: null, relation: "users", values: {} }, columns, pg, "postgres").text).toBe(
            'INSERT INTO "public"."users" DEFAULT VALUES'
        );
        expect(prepareInsert({ namespace: "app", relation: "users", values: {} }, columns, my, "mysql").text).toBe(
            "INSERT INTO `app`.`users` () VALUES ()"
        );
    });

    it("refuses a column the table does not have, and NULL where it is not allowed", () => {
        expect(() =>
            prepareInsert({ namespace: null, relation: "users", values: { password: "x" } }, columns, pg, "postgres")
        ).toThrow("There is no column called password.");
        expect(() =>
            prepareInsert({ namespace: null, relation: "users", values: { email: null } }, columns, pg, "postgres")
        ).toThrow("email cannot be empty.");
    });
});

describe("removing rows", () => {
    it("is aimed by each row's whole primary key, values bound", () => {
        const prepared = prepareDelete({ namespace: "app", relation: "users", keys: [{ id: 1 }, { id: "2 OR 1=1" }] }, columns, my);
        expect(prepared.text).toBe("DELETE FROM `app`.`users` WHERE (`id` = ?) OR (`id` = ?)");
        expect(prepared.params).toEqual([1, "2 OR 1=1"]);
    });

    it("refuses a table with no key, a partial key, nothing picked and too many", () => {
        const keyless = columns.map((entry) => ({ ...entry, primaryKey: false }));
        expect(() => prepareDelete({ namespace: null, relation: "t", keys: [{ id: 1 }] }, keyless, pg)).toThrow(/no primary key/);
        expect(() => prepareDelete({ namespace: null, relation: "t", keys: [{ email: "a" }] }, columns, pg)).toThrow(
            /whole primary key/
        );
        expect(() => prepareDelete({ namespace: null, relation: "t", keys: [] }, columns, pg)).toThrow("Pick the rows to remove.");
        const many = Array.from({ length: 201 }, (_value, index) => ({ id: index }));
        expect(() => prepareDelete({ namespace: null, relation: "t", keys: many }, columns, pg)).toThrow(/at most 200/);
        expect(rowDeleteSchema.safeParse({ namespace: null, relation: "t", keys: many }).success).toBe(false);
    });
});

describe("a new table", () => {
    it("writes names quoted and types from the fixed list, per engine", () => {
        const draft: Partial<TableDraft> = {
            columns: [
                column({ name: "id", type: "bigserial", primaryKey: true, nullable: false }),
                column({ name: "email", type: "varchar", nullable: false, unique: true }),
                column({ name: "created_at", type: "timestamptz", defaultValue: { kind: "expression", expression: "now" } }),
                column({ name: "paid", type: "boolean", defaultValue: { kind: "value", value: "false" } })
            ]
        };
        expect(create(draft)).toBe(
            'CREATE TABLE "public"."orders" ("id" BIGSERIAL NOT NULL, "email" VARCHAR(255) NOT NULL UNIQUE, "created_at" TIMESTAMPTZ DEFAULT now(), "paid" BOOLEAN DEFAULT FALSE, PRIMARY KEY ("id"))'
        );
        expect(create({ ...draft, namespace: "app" }, "mysql")).toBe(
            "CREATE TABLE `app`.`orders` (`id` BIGINT AUTO_INCREMENT NOT NULL, `email` VARCHAR(255) NOT NULL UNIQUE, `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP, `paid` BOOLEAN DEFAULT FALSE, PRIMARY KEY (`id`))"
        );
    });

    it("quotes a typed default as a literal, doubling the quote", () => {
        expect(create({ columns: [column({ defaultValue: { kind: "value", value: "it's" } })] })).toContain(
            "DEFAULT 'it''s'"
        );
    });

    it("refuses a name that is not a plain identifier, so nothing typed becomes SQL", () => {
        expect(() => create({ name: 'orders"; DROP TABLE users; --' })).toThrow(/table name starts with a letter/);
        expect(() => create({ columns: [column({ name: "a b" })] })).toThrow(/cannot be a column name/);
        expect(tableDraftSchema.safeParse({ namespace: null, name: "1orders", columns: [column({})] }).success).toBe(false);
    });

    it("refuses defaults that could be read two ways, or do not fit", () => {
        expect(() => defaultLiteral("text", "a\\'b")).toThrow(/backslash/);
        expect(() => defaultLiteral("text", "a\nb")).toThrow(/backslash/);
        expect(() => defaultLiteral("integer", "1; DROP")).toThrow("That default has to be a number.");
        expect(() => defaultLiteral("boolean", "yes")).toThrow(/true or false/);
        expect(() =>
            create({ columns: [column({ type: "integer", defaultValue: { kind: "expression", expression: "now" } })] })
        ).toThrow(/does not fit the type/);
    });

    it("keeps auto-numbered columns as keys with no default, and names unique", () => {
        expect(() => create({ columns: [column({ name: "id", type: "serial" })] })).toThrow(/has to be the primary key/);
        expect(() =>
            create({
                columns: [column({ name: "id", type: "serial", primaryKey: true, defaultValue: { kind: "value", value: "1" } })]
            })
        ).toThrow(/takes no default/);
        expect(() => create({ columns: [column({ name: "a" }), column({ name: "A" })] })).toThrow("There are two columns called A.");
        const parsed = tableDraftSchema.safeParse({ namespace: null, name: "t", columns: [column({ name: "a" }), column({ name: "A" })] });
        expect(parsed.success).toBe(false);
    });

    it("never lets a primary key be nullable", () => {
        expect(create({ columns: [column({ name: "id", type: "integer", primaryKey: true, nullable: true })] })).toBe(
            'CREATE TABLE "public"."orders" ("id" INTEGER NOT NULL, PRIMARY KEY ("id"))'
        );
    });
});
