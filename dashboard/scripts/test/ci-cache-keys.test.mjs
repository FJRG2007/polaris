import { test } from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * Dashboard CI restores the built packages and the Next cache that
 * dashboard-cache.yml saves on main, and a cache is only found by its exact key.
 * The packages key lives once, in .github/actions/workspace-packages; the Next
 * key is written out where it is used, and one edited without the other is a
 * cache nobody ever hits, so CI quietly goes back to building everything. These
 * fail first.
 */

const workflows = join(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    "..",
    ".github",
    "workflows"
);
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

test("every workflow takes the built packages from the one shared action", () => {
    const uses = /uses:\s*\.\/\.github\/actions\/workspace-packages/g;
    assert.equal(ci.match(uses)?.length, 3, "the checks job, the web test shards and the app build");
    assert.equal(warm.match(uses)?.length, 1, "the warming build");
    for (const name of readdirSync(workflows).filter((file) => file.endsWith(".yml")))
        assert.deepEqual(keys(read(name), "packages-"), [], `${name} writes its own packages key`);
});

test("the packages key leaves out everything the build writes, and is saved as restored", () => {
    const action = readFileSync(join(workflows, "..", "actions", "workspace-packages", "action.yml"), "utf8");
    const [key] = keys(action, "packages-");
    assert.ok(key, "the action defines the packages key");
    for (const output of ["dist", "node_modules", "db/generated"])
        assert.match(key, new RegExp(`'!dashboard/packages/[^']*${output}/\\*\\*'`), output);
    assert.match(action, /key:\s*\$\{\{\s*steps\.restore\.outputs\.cache-primary-key\s*\}\}/);
    assert.match(action, /if:\s*steps\.build\.outcome == 'success'/, "saved only after a build that passed");
});

test("pull requests restore the Next cache under the prefix main saves it with", () => {
    const [used] = keys(ci, "next-");
    const saved = keys(warm, "next-");
    assert.ok(used, "the app build restores a Next cache");
    assert.equal(saved.length, 2, "restored, then saved, under one key");
    assert.equal(saved[0], saved[1]);
    assert.equal(used, saved[0]);
});

test("the CI build and the warming build skip the same lint", () => {
    const flag = /POLARIS_BUILD_SKIP_LINT:\s*"1"/;
    assert.match(ci, flag);
    assert.match(warm, flag);
});
