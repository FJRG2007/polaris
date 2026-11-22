/**
 * The ledger check (docs/rust-core-plan.md, unit F7): every domain in
 * src/domains.json has a row in docs/rust-core-ledger.md that names it, and
 * every row that names a domain and has started has that domain here. Also
 * refuses a state the plan does not define and a started unit with no proof.
 *
 *   npm run check:ledger -w @polaris/core-rs        (plain Node, no install needed)
 */

import { join } from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

const packageDir = fileURLToPath(new URL("..", import.meta.url));
const repoRoot = join(packageDir, "..", "..", "..");

export const STATES = ["not started", "in progress", "built", "shadow", "serving", "TS removed", "blocked"];
const COLUMNS = ["Unit", "Domain", "TS source", "State", "Checks", "Budgets", "Shadow", "Blocker"];

/** Parse the ledger's table into rows keyed by column name. */
export function parseLedger(text) {
    const lines = text.split("\n").filter((l) => l.trim().startsWith("|"));
    if (lines.length < 2) throw new Error("the ledger has no table");
    const cells = (line) =>
        line
            .trim()
            .replace(/^\||\|$/g, "")
            .split("|")
            .map((c) => c.trim());
    const header = cells(lines[0]);
    if (header.join("|") !== COLUMNS.join("|")) throw new Error(`the ledger's columns must be: ${COLUMNS.join(", ")}`);
    return lines.slice(2).map((line, i) => {
        const values = cells(line);
        if (values.length !== COLUMNS.length) throw new Error(`ledger row ${i + 1} has ${values.length} cells, expected ${COLUMNS.length}`);
        const row = Object.fromEntries(COLUMNS.map((c, j) => [c, values[j]]));
        row.id = row.Unit.split(/\s+/)[0];
        row.domains = row.Domain === "-" || row.Domain === "" ? [] : row.Domain.split(",").map((d) => d.trim().replace(/`/g, ""));
        return row;
    });
}

/** Every problem between the domain table and the ledger; empty means consistent. */
export function check(domains, rows) {
    const problems = [];
    const ids = new Set();
    for (const row of rows) {
        if (ids.has(row.id)) problems.push(`unit ${row.id} has two rows`);
        ids.add(row.id);
        if (!STATES.includes(row.State)) problems.push(`unit ${row.id} has an unknown state "${row.State}"`);
        if (row.State === "blocked" && !row.Blocker) problems.push(`unit ${row.id} is blocked with no reason`);
        if (row.State !== "not started" && row.State !== "blocked" && !row.Checks) problems.push(`unit ${row.id} is "${row.State}" with nothing in Checks`);
    }
    for (const [name, config] of Object.entries(domains)) {
        const row = rows.find((r) => r.id === config.ledger);
        if (!row) problems.push(`domain ${name} points at unit ${config.ledger}, which has no ledger row`);
        else if (!row.domains.includes(name)) problems.push(`domain ${name}: ledger row ${row.id} does not name it in Domain`);
    }
    for (const row of rows)
        for (const name of row.domains) {
            if (row.State === "not started" || row.State === "blocked") continue;
            if (!domains[name]) problems.push(`ledger row ${row.id} is "${row.State}" for domain ${name}, which is not in src/domains.json`);
            else if (domains[name].ledger !== row.id && !rows.some((r) => r.id === domains[name].ledger)) problems.push(`domain ${name} is owned by no row`);
        }
    return problems;
}

function main() {
    const domains = JSON.parse(readFileSync(join(packageDir, "src", "domains.json"), "utf8"));
    const rows = parseLedger(readFileSync(join(repoRoot, "docs", "rust-core-ledger.md"), "utf8"));
    const problems = check(domains, rows);
    for (const p of problems) process.stdout.write(`[ledger-check] ${p}\n`);
    process.stdout.write(`[ledger-check] ${rows.length} rows, ${Object.keys(domains).length} domains, ${problems.length} problems\n`);
    process.exit(problems.length ? 1 : 0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
