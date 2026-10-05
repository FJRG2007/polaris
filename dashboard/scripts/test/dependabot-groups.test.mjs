import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readFileSync, readdirSync, existsSync } from "node:fs";

/**
 * Below 1.0 a minor release may break, so Dependabot groups every 0.x
 * dependency apart from the routine minor-and-patch pull request - by name,
 * which is the only way its config can say it. A 0.x dependency added later
 * and not named there would ride in the routine group again; this fails first.
 */

const dashboard = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const config = readFileSync(join(dashboard, "..", ".github", "dependabot.yml"), "utf8");

/** The patterns listed under one npm group of .github/dependabot.yml. */
function groupPatterns(name) {
    const lines = config.split("\n");
    const start = lines.findIndex((line) => line.trim() === `${name}:`);
    assert.ok(start >= 0, `group ${name} is missing from dependabot.yml`);
    const indent = lines[start].search(/\S/);
    const patterns = [];
    for (const line of lines.slice(start + 1)) {
        const depth = line.search(/\S/);
        if (depth >= 0 && depth <= indent && !line.trim().startsWith("#")) break;
        const item = /^\s*-\s*"([^"]+)"\s*$/.exec(line);
        if (item) patterns.push(item[1]);
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

test("the pre-1.0 group comes before the routine one, so it wins", () => {
    assert.ok(config.indexOf("pre-1.0:") < config.indexOf("minor-and-patch:"));
    assert.ok(config.indexOf("auth-and-security:") < config.indexOf("minor-and-patch:"));
});
