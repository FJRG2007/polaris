import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { packageDir } from "../support/files";
// @ts-expect-error - a plain ES module script without type declarations
import { scan } from "../../scripts/no-simulation-guard.mjs";
// @ts-expect-error - a plain ES module script without type declarations
import { check, parseLedger } from "../../scripts/ledger-check.mjs";
// @ts-expect-error - a plain ES module script without type declarations
import { BINDING_CRATES, checkCrate, checkManifest, checkSource } from "../../scripts/binding-check.mjs";

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

describe("binding check", () => {
    const binding = (body: string, head = "#[napi(catch_unwind)]\npub fn probe_x(text: String) -> u32") => `${head} {\n    ${body}\n}\n`;

    it("passes the real binding crates", () => {
        for (const name of BINDING_CRATES) expect(checkCrate(join(packageDir, "..", "..", "..", "crates", name)), name).toEqual([]);
    });

    it("passes a binding that only converts and delegates", () => {
        expect(checkSource(binding("polaris_core::probe::fnv1a32(&text)"))).toEqual([]);
        expect(checkSource(binding('panic!("deliberate")', "#[wasm_bindgen(js_name = probePanic)]\npub fn probe_panic()"))).toEqual([]);
        // Keywords inside comments and strings are not code.
        expect(checkSource(`// if a match loops\n${binding('polaris_core::probe::fnv1a32("if for x in y")')}`)).toEqual([]);
    });

    it("fails on logic living in a binding", () => {
        const planted = [
            "if text.is_empty() { 0 } else { polaris_core::probe::fnv1a32(&text) }",
            "match text.len() { _ => polaris_core::probe::fnv1a32(&text) }",
            "let mut h = 0; for b in text.bytes() { h ^= b as u32; } polaris_core::probe::fnv1a32(&text) ^ h",
            "polaris_core::probe::fnv1a32(&text) ^ 0x811c9dc5",
            "loop { break polaris_core::probe::fnv1a32(&text) }",
            "unsafe { polaris_core::probe::fnv1a32(&text) }"
        ];
        for (const body of planted) expect(checkSource(binding(body)).length, body).toBeGreaterThan(0);
        expect(checkSource(`const BASIS: u32 = 7;\n${binding("polaris_core::probe::fnv1a32(&text)")}`)).toHaveLength(1);
        expect(checkSource(`mod hashing;\n${binding("polaris_core::probe::fnv1a32(&text)")}`)).toHaveLength(1);
    });

    it("fails on an export that does not call into polaris_core", () => {
        expect(checkSource(binding("text.len() as u32"))).toEqual(["export probe_x does not call into polaris_core"]);
        expect(checkSource('fn helper() {}\n')).toEqual(["no exported function found"]);
    });

    it("fails on a dependency beyond the binding toolkit", () => {
        const ok = '[dependencies]\npolaris-core = { path = "../polaris-core" }\nnapi = "1"\n\n[build-dependencies]\nnapi-build = "2"\n';
        expect(checkManifest(ok)).toEqual([]);
        expect(checkManifest(`${ok}\n[dependencies.extra]\nversion = "1"\n`)).toEqual(["dependency extra is not part of the binding toolkit"]);
        expect(checkManifest('[dependencies]\nregex = "1"\n')).toEqual(["dependency regex is not part of the binding toolkit"]);
        expect(checkManifest('[dependencies]\n\n[target.\'cfg(unix)\'.dependencies]\nlibc = "1"\n')).toHaveLength(1);
    });
});
