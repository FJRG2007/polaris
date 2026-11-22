import { describe, expect, it } from "vitest";
// @ts-expect-error - a plain ES module script without type declarations
import { scan } from "../../scripts/no-simulation-guard.mjs";
// @ts-expect-error - a plain ES module script without type declarations
import { check, parseLedger } from "../../scripts/ledger-check.mjs";

describe("no-simulation guard", () => {
    it("catches every banned marker", () => {
        const planted = [
            "fn a() { todo!() }",
            "unimplemented!()",
            "#[ignore]",
            "let x = dbg!(y);",
            'throw new Error("not implemented");',
            "it.skip('x', () => {})",
            "describe.only('x', () => {})",
            "test.todo('x')",
            "xit('x', () => {})"
        ];
        for (const line of planted) expect(scan(line), line).toHaveLength(1);
        expect(scan('println!("x")', { rustLibrary: true })).toHaveLength(1);
        expect(scan('println!("x")')).toHaveLength(0);
        expect(scan("const total = items.length;")).toHaveLength(0);
    });
});

describe("ledger check", () => {
    const header = "| Unit | Domain | TS source | State | Checks | Budgets | Shadow | Blocker |\n|---|---|---|---|---|---|---|---|\n";
    const ledger = (rows: string) => parseLedger(header + rows);

    it("passes when domains and rows agree", () => {
        const rows = ledger("| F4 framework | `probe` | new | in progress | local: vitest | | | |\n| P1 phone | phone | x | not started | | | | |\n");
        expect(check({ probe: { ledger: "F4" } }, rows)).toEqual([]);
    });

    it("fails on a domain with no row", () => {
        expect(check({ probe: { ledger: "F9" } }, ledger("| F4 x | - | new | not started | | | | |\n"))).toHaveLength(1);
    });

    it("fails on a row that does not name its domain", () => {
        expect(check({ probe: { ledger: "F4" } }, ledger("| F4 x | - | new | not started | | | | |\n"))).toHaveLength(1);
    });

    it("fails on a started row for a domain that does not exist", () => {
        expect(check({}, ledger("| P2 x | phone | x | built | ci | | | |\n"))).toHaveLength(1);
    });

    it("fails on an unknown state, a blocked row with no reason, and a started row with no proof", () => {
        expect(check({}, ledger("| A x | - | x | done | ci | | | |\n| B x | - | x | blocked | | | | |\n| C x | - | x | built | | | | |\n"))).toHaveLength(3);
    });

    it("refuses a table with the wrong columns", () => {
        expect(() => parseLedger("| Unit | State |\n|---|---|\n| F1 | x |\n")).toThrow();
    });
});
