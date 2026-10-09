import { test } from "node:test";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * Dashboard CI restores the built packages and the Next cache that
 * dashboard-cache.yml saves on main, and a cache is only found by its exact key.
 * The keys cannot be shared between files, so each is written out where it is
 * used; one edited and the others not is a cache nobody ever hits, and CI quietly goes
 * back to building everything. These fail first.
 */

const workflows = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", ".github", "workflows");
const read = (name) => readFileSync(join(workflows, name), "utf8");

/** Every `key:` line of a workflow whose value starts with `prefix`. */
function keys(source, prefix) {
    return source
        .split("\n")
        .map((line) => /^\s*key:\s*(.+)$/.exec(line)?.[1].trim())
        .filter((key) => key?.startsWith(prefix));
}

const ci = read("dashboard-ci.yml");
const warm = read("dashboard-cache.yml");

test("every job reads the built packages under the key main saves them with", () => {
    const used = keys(ci, "packages-");
    const saved = keys(warm, "packages-");
    assert.equal(used.length, 3, "the checks job, the web test shards and the app build");
    assert.equal(saved.length, 2, "restored, then saved only after a build that passed");
    for (const key of [...used, saved[1]]) assert.equal(key, saved[0]);
});

test("the packages key leaves out everything the build writes", () => {
    const [key] = keys(warm, "packages-");
    for (const output of ["dist", "node_modules", "db/generated"])
        assert.match(key, new RegExp(`'!dashboard/packages/[^']*${output}/\\*\\*'`), output);
});

test("pull requests restore the Next cache under the prefix main saves it with", () => {
    const [used] = keys(ci, "next-");
    const saved = keys(warm, "next-");
    assert.ok(used, "the app build restores a Next cache");
    assert.equal(saved.length, 2, "restored, then saved, under one key");
    assert.equal(saved[0], saved[1]);
    assert.equal(used, saved[0]);
});

test("the CI build and the warming build skip the same checks", () => {
    const flag = /POLARIS_BUILD_SKIP_CHECKS:\s*"1"/;
    assert.match(ci, flag);
    assert.match(warm, flag);
});
