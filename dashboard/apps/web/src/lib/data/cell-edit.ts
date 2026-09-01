/**
 * Turning "change this cell" into a statement that can only change that cell.
 *
 * This is the one write the grid makes, and it is the feature of a database
 * client that can quietly destroy somebody's afternoon - so everything it does
 * is decided here, once, and both SQL drivers share it rather than each building
 * their own UPDATE.
 *
 * Three rules, and each of them is the answer to a specific way this goes wrong:
 *
 * - **The row is found by its primary key and by nothing else.** A WHERE built
 *   from the values that happened to be on screen matches every row that looks
 *   the same, so "update the row I clicked" silently becomes "update the four
 *   rows with that email address". A table with no primary key is not editable,
 *   and the grid says so rather than offering an edit it cannot aim.
 * - **Every key column is required.** A partial key is a WHERE that matches a
 *   group, which is the same failure wearing a different hat.
 * - **Names are checked against the catalogue, values are bound.** A column name
 *   is compared to the ones the driver just read and then quoted; a value never
 *   touches the statement text. Neither half is optional: quoting a name that was
 *   never checked still lets somebody address a column they were not shown.
 *
 * The statement is built with placeholders in a shape each engine understands,
 * which is the only thing the two callers differ on.
 */

import * as data from "./driver";

/** What one engine needs said differently. */
export interface SqlDialect {
    /** How this engine quotes an identifier. */
    readonly quote: (name: string) => string;
    /** The placeholder for the nth bound parameter, one-based. Postgres counts
     *  them (`$1`); MySQL does not (`?`). */
    readonly placeholder: (index: number) => string;
    /** The table, qualified and quoted. */
    readonly target: string;
}

/** A statement and the values to bind to it. */
export interface PreparedEdit {
    readonly text: string;
    readonly params: unknown[];
}

/**
 * The UPDATE for one cell, or a refusal.
 *
 * Throws rather than returning a flag: every one of these is a request that must
 * not be sent, and a caller that forgot to check a boolean would send it.
 */
export function prepareCellEdit(
    edit: data.CellEdit,
    columns: readonly data.DataColumn[],
    dialect: SqlDialect
): PreparedEdit {
    const keyColumns = columns.filter((column) => column.primaryKey);
    if (keyColumns.length === 0) {
        throw new data.DataRequestError(
            "This table has no primary key, so there is no way to change one row of it without risking the others. Use the statement box."
        );
    }

    const target = columns.find((column) => column.name === edit.column);
    if (!target) throw new data.DataRequestError("No such column to change.");
    if (target.primaryKey) {
        // Not a technical limit - it is that changing a key is a different act
        // with different consequences (every row pointing at it), and doing it
        // by double-clicking a cell is not how anybody should discover that.
        throw new data.DataRequestError(
            "That column is part of the primary key. Changing it moves the row, so it goes through the statement box."
        );
    }
    if (edit.value === null && !target.nullable) {
        // Said here rather than left to the engine, whose message names a
        // constraint rather than the column somebody was looking at.
        throw new data.DataRequestError(`${target.name} cannot be empty.`);
    }

    const missing = keyColumns.filter((column) => !(column.name in edit.key));
    if (missing.length > 0) {
        throw new data.DataRequestError(
            "That row cannot be identified - the page it came from did not carry its whole primary key."
        );
    }

    const params: unknown[] = [edit.value];
    const conditions = keyColumns.map((column) => {
        params.push(edit.key[column.name]);
        return `${dialect.quote(column.name)} = ${dialect.placeholder(params.length)}`;
    });

    return {
        text: `UPDATE ${dialect.target} SET ${dialect.quote(target.name)} = ${dialect.placeholder(1)} WHERE ${conditions.join(" AND ")}`,
        params
    };
}
