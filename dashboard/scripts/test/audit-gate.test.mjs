import { test } from "node:test";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { collectAdvisories, evaluate, parseAllowlist, render } from "../audit-gate.mjs";

const HIGH = "GHSA-vfj7-8cjw-p6xm";
const OTHER = "GHSA-86w9-cpqp-85rv";

/** The shape `npm audit --json` writes: the advisory on its package, and every dependent pointing at it by name. */
function report(entries) {
    const vulnerabilities = {};
    for (const [name, via, severity = "high"] of entries) {
        vulnerabilities[name] = { name, severity, via, nodes: [`node_modules/${name}`] };
    }
    return { vulnerabilities, metadata: { vulnerabilities: { critical: 0, high: entries.length, moderate: 0, low: 0, info: 0 } } };
}

const advisory = (id, severity = "high") => ({ url: `https://github.com/advisories/${id}`, severity, title: "t", range: "<1" });
const accept = (id, name, expires = "2999-01-01") => ({ id, package: name, reason: "a reason long enough to read", expires });
const today = new Date("2026-10-05T12:00:00Z");

test("an advisory is counted once on its own package, not on every dependent", () => {
    const found = collectAdvisories(report([["braces", [advisory(HIGH)]], ["micromatch", ["braces"]], ["fast-glob", ["micromatch"]]]));
    assert.deepEqual(found.map((a) => `${a.id} ${a.package}`), [`${HIGH} braces`]);
});

test("a high advisory nobody accepted fails the gate", () => {
    const result = evaluate(collectAdvisories(report([["braces", [advisory(HIGH)]]])), [], today);
    assert.equal(result.pass, false);
    assert.equal(result.failing.length, 1);
});

test("an accepted advisory passes, an expired acceptance fails again", () => {
    const found = collectAdvisories(report([["braces", [advisory(HIGH)]]]));
    assert.equal(evaluate(found, [accept(HIGH, "braces")], today).pass, true);
    const expired = evaluate(found, [accept(HIGH, "braces", "2026-10-04")], today);
    assert.equal(expired.pass, false);
    assert.equal(expired.expired.length, 1);
});

test("an acceptance covers its package only", () => {
    const found = collectAdvisories(report([["braces", [advisory(HIGH)]], ["other", [advisory(HIGH)]]]));
    const result = evaluate(found, [accept(HIGH, "braces")], today);
    assert.deepEqual(result.failing.map((a) => a.package), ["other"]);
});

test("moderate advisories are reported and never fail", () => {
    const found = collectAdvisories(report([["dompurify", [advisory(HIGH, "moderate")], "moderate"]]));
    assert.equal(evaluate(found, [], today).pass, true);
});

test("an acceptance whose advisory is gone is called out as stale", () => {
    const result = evaluate([], [accept(OTHER, "node-forge")], today);
    assert.equal(result.pass, true);
    assert.deepEqual(result.stale.map((e) => e.id), [OTHER]);
    assert.match(render("t", report([]), [], result), /can be removed: GHSA-86w9-cpqp-85rv \(node-forge\)/);
});

test("a report npm failed to produce is an error, not a clean audit", () => {
    assert.throws(() => collectAdvisories({ error: { code: "ENOLOCK", summary: "no lockfile" } }), /npm failed/);
    assert.throws(() => collectAdvisories({}), /no vulnerabilities map/);
});

test("an allowlist entry has to say what, why and until when", () => {
    assert.throws(() => parseAllowlist({ accepted: [{ ...accept(HIGH, "braces"), id: "CVE-2024-1" }] }), /GHSA/);
    assert.throws(() => parseAllowlist({ accepted: [{ ...accept(HIGH, "braces"), reason: "dev" }] }), /why/);
    assert.throws(() => parseAllowlist({ accepted: [{ ...accept(HIGH, "braces"), expires: "soon" }] }), /YYYY-MM-DD/);
});

test("the committed allowlist is well formed", () => {
    const file = fileURLToPath(new URL("../audit-allowlist.json", import.meta.url));
    const entries = parseAllowlist(JSON.parse(readFileSync(file, "utf8")));
    assert.ok(entries.length > 0);
    const keys = entries.map((e) => `${e.id} ${e.package}`);
    assert.equal(new Set(keys).size, keys.length, "duplicate acceptance");
});
