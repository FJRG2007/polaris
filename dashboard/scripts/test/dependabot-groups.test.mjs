import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readFileSync, readdirSync, existsSync } from "node:fs";

/**
 * Below 1.0 a minor release may break, and a minor of an auth library changes
 * what an attacker meets, so neither may ride in Dependabot's routine
 * minor-and-patch pull request. Its config can only say that by name: every 0.x
 * dependency is listed in the pre-1.0 group, and every name of the special
 * groups is excluded from the routine one. A dependency added later and not
 * listed would slip back in; these fail first.
 */

const dashboard = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const config = readFileSync(join(dashboard, "..", ".github", "dependabot.yml"), "utf8");

/** The patterns (or exclude-patterns) listed under one npm group of .github/dependabot.yml. */
function groupPatterns(name, key = "patterns") {
    const lines = config.split("\n");
    const start = lines.findIndex((line) => line.trim() === `${name}:`);
    assert.ok(start >= 0, `group ${name} is missing from dependabot.yml`);
    const indent = lines[start].search(/\S/);
    const patterns = [];
    let field = null;
    for (const line of lines.slice(start + 1)) {
        const depth = line.search(/\S/);
        if (depth >= 0 && depth <= indent && !line.trim().startsWith("#")) break;
        const named = /^\s*([a-z-]+):/.exec(line);
        if (named) field = named[1];
        const item = /^\s*-\s*"([^"]+)"\s*$/.exec(line);
        if (item && field === key) patterns.push(item[1]);
    }
    return patterns;
}

const matches = (pattern, name) =>
    new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\/]/g, "\\$&").replaceAll("*", ".*")}$`).test(
        name
    );

/** Every direct dependency of every workspace, with the version it pins. */
function directDependencies() {
    const manifests = ["package.json"];
    for (const group of ["apps", "packages", "services"]) {
        for (const entry of readdirSync(join(dashboard, group))) {
            if (existsSync(join(dashboard, group, entry, "package.json")))
                manifests.push(join(group, entry, "package.json"));
        }
    }
    const found = new Map();
    for (const manifest of manifests) {
        const pkg = JSON.parse(readFileSync(join(dashboard, manifest), "utf8"));
        for (const [name, version] of Object.entries({
            ...pkg.dependencies,
            ...pkg.devDependencies
        })) {
            if (!name.startsWith("@polaris")) found.set(name, version);
        }
    }
    return found;
}

test("every direct dependency below 1.0 is in the pre-1.0 group", () => {
    const patterns = groupPatterns("pre-1.0");
    const missing = [...directDependencies()]
        .filter(([, version]) => /^[~^]?0\./.test(version))
        .map(([name]) => name)
        .filter((name) => !patterns.some((pattern) => matches(pattern, name)));
    assert.deepEqual(
        missing,
        [],
        `add these to the pre-1.0 group in .github/dependabot.yml: ${missing.join(", ")}`
    );
});

test("the routine group excludes every name the special groups hold", () => {
    const excluded = new Set(groupPatterns("minor-and-patch", "exclude-patterns"));
    const special = ["auth-and-security", "framework", "pre-1.0"].flatMap((group) =>
        groupPatterns(group)
    );
    assert.ok(special.length > 0);
    assert.deepEqual(
        special.filter((pattern) => !excluded.has(pattern)),
        [],
        "add these to minor-and-patch exclude-patterns in .github/dependabot.yml"
    );
});

test("no group bundles majors: each one arrives alone", () => {
    // An ignore rule's "version-update:semver-major" holds majors back; only a group's "major" bundles them.
    assert.doesNotMatch(config, /update-types: \[[^\]]*(?<!semver-)\bmajor\b/);
    const npm = config.slice(0, config.indexOf("package-ecosystem: github-actions"));
    const groups = npm.split(/^ {6}(?=[a-z0-9.-]+:\s*$)/m).slice(1);
    const unbounded = groups
        .filter((body) => /^\s*applies-to: version-updates\s*$/m.test(body))
        .filter((body) => !/^\s*update-types: \[/m.test(body))
        .map((body) => body.slice(0, body.indexOf(":")));
    assert.ok(groups.length > 0);
    assert.deepEqual(
        unbounded,
        [],
        `give these groups update-types without major: ${unbounded.join(", ")}`
    );
});
