/**
 * The one write the grid makes.
 *
 * A cell that saves as you leave it is the feature of a database client that can
 * quietly destroy somebody's afternoon, so what is asserted here is almost
 * entirely refusals - and the refusals are not tidiness, each one is a specific
 * way this goes wrong in a way nobody notices until much later:
 *
 * - **A WHERE built from anything but the primary key matches a group.** "Update
 *   the row I clicked" silently becomes "update the four rows with that email
 *   address", and the grid still shows one row changing because it re-reads a
 *   page of a hundred.
 * - **A partial key is the same failure wearing a different hat**, so every key
 *   column has to be named.
 * - **A value must never reach the statement text.** It is bound, always, and the
 *   test for that is that a value full of SQL comes out as a parameter.
 * - **A table with no primary key is not editable at all**, rather than editable
 *   with a wider WHERE.
 */

import { describe, expect, it } from "vitest";
import { prepareCellEdit } from "@/lib/data/cell-edit";
import { DataRequestError, type CellEdit, type DataColumn } from "@/lib/data/driver";

/** Postgres' way of saying it, which is the numbered one. */
const POSTGRES = {
    quote: (name: string) => `"${name.replace(/"/g, '""')}"`,
    placeholder: (index: number) => `$${index}`,
    target: '"public"."users"'
};

/** MySQL's, which is not. */
const MYSQL = {
    quote: (name: string) => `\`${name.replace(/`/g, "``")}\``,
    placeholder: () => "?",
    target: "`app`.`users`"
};

function column(over: Partial<DataColumn> & { name: string }): DataColumn {
    return { type: "text", nullable: true, primaryKey: false, ...over };
}

const COLUMNS: DataColumn[] = [
    column({ name: "id", primaryKey: true, nullable: false }),
    column({ name: "email", nullable: false }),
    column({ name: "note" })
];

function edit(over: Partial<CellEdit> = {}): CellEdit {
    return {
        namespace: "public",
        relation: "users",
        column: "email",
        value: "ada@example.test",
        key: { id: 7 },
        ...over
    };
}

describe("the statement a cell edit becomes", () => {
    it("finds the row by its primary key and by nothing else", () => {
        const prepared = prepareCellEdit(edit(), COLUMNS, POSTGRES);
        expect(prepared.text).toBe('UPDATE "public"."users" SET "email" = $1 WHERE "id" = $2');
        expect(prepared.params).toEqual(["ada@example.test", 7]);
    });

    it("binds the value rather than writing it into the statement", () => {
        // The whole reason this is not string interpolation.
        const nasty = "'; DROP TABLE users; --";
        const prepared = prepareCellEdit(edit({ value: nasty }), COLUMNS, POSTGRES);
        expect(prepared.text).not.toContain("DROP");
        expect(prepared.params[0]).toBe(nasty);
    });

    it("names every key column of a table keyed by more than one", () => {
        const columns = [
            column({ name: "tenant", primaryKey: true, nullable: false }),
            column({ name: "id", primaryKey: true, nullable: false }),
            column({ name: "note" })
        ];
        const prepared = prepareCellEdit(
            edit({ column: "note", value: "x", key: { tenant: "acme", id: 3 } }),
            columns,
            POSTGRES
        );
        expect(prepared.text).toContain('WHERE "tenant" = $2 AND "id" = $3');
        expect(prepared.params).toEqual(["x", "acme", 3]);
    });

    it("uses each engine's own placeholders", () => {
        const prepared = prepareCellEdit(edit(), COLUMNS, MYSQL);
        expect(prepared.text).toBe("UPDATE `app`.`users` SET `email` = ? WHERE `id` = ?");
    });

    it("quotes a name that would otherwise break out of its identifier", () => {
        const columns = [
            column({ name: "id", primaryKey: true, nullable: false }),
            column({ name: 'we"ird' })
        ];
        const prepared = prepareCellEdit(edit({ column: 'we"ird', value: "x" }), columns, POSTGRES);
        expect(prepared.text).toContain('SET "we""ird" = $1');
    });

    it("writes a real NULL for an empty value on a nullable column", () => {
        const prepared = prepareCellEdit(edit({ column: "note", value: null }), COLUMNS, POSTGRES);
        expect(prepared.params[0]).toBeNull();
    });
});

describe("what it refuses to build at all", () => {
    it("refuses a table with no primary key", () => {
        const columns = [column({ name: "email" }), column({ name: "note" })];
        expect(() => prepareCellEdit(edit(), columns, POSTGRES)).toThrow(DataRequestError);
    });

    it("refuses a key that is not fully named", () => {
        const columns = [
            column({ name: "tenant", primaryKey: true, nullable: false }),
            column({ name: "id", primaryKey: true, nullable: false }),
            column({ name: "note" })
        ];
        // Only half the key, which would make the WHERE match a group.
        expect(() =>
            prepareCellEdit(edit({ column: "note", key: { id: 3 } }), columns, POSTGRES)
        ).toThrow(DataRequestError);
    });

    it("refuses a column the table does not have", () => {
        expect(() => prepareCellEdit(edit({ column: "smuggled" }), COLUMNS, POSTGRES)).toThrow(
            DataRequestError
        );
    });

    it("refuses to change a key column", () => {
        // Not a technical limit: changing a key moves the row, and every row
        // pointing at it, which is not something to discover by double-clicking.
        expect(() => prepareCellEdit(edit({ column: "id", value: "9" }), COLUMNS, POSTGRES)).toThrow(
            DataRequestError
        );
    });

    it("refuses to empty a column that cannot be empty", () => {
        expect(() => prepareCellEdit(edit({ column: "email", value: null }), COLUMNS, POSTGRES)).toThrow(
            DataRequestError
        );
    });
});
