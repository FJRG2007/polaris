import { test } from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import {
    latestTagged,
    manifestVersion,
    nextVersion,
    parseVersion,
    stampConstant
} from "../release-version.mjs";

const SCRIPT = fileURLToPath(new URL("../release-version.mjs", import.meta.url));
const PREFIX = "streamdeck-v";

test("the first release is the package's own version", () => {
    assert.equal(nextVersion([], PREFIX, "0.1.0"), "0.1.0");
});

test("after a release the patch moves on, without a bump in package.json", () => {
    assert.equal(nextVersion(["streamdeck-v0.1.0"], PREFIX, "0.1.0"), "0.1.1");
    assert.equal(nextVersion(["streamdeck-v0.1.0", "streamdeck-v0.1.1"], PREFIX, "0.1.0"), "0.1.2");
});

test("versions sort as numbers, not as text", () => {
    assert.equal(
        nextVersion(["streamdeck-v0.1.9", "streamdeck-v0.1.10"], PREFIX, "0.1.0"),
        "0.1.11"
    );
});

test("a package.json raised past every release is the next version", () => {
    assert.equal(nextVersion(["streamdeck-v0.1.7"], PREFIX, "0.2.0"), "0.2.0");
    assert.equal(nextVersion(["streamdeck-v0.1.7"], PREFIX, "1.0.0"), "1.0.0");
});

test("other apps' tags and prereleases are not releases of this one", () => {
    const tags = [
        "companion-v3.0.0",
        "extension-v2.4.1",
        "streamdeck-v0.4.0-rc.1",
        "streamdeck-v0.1.2",
        "dashboard-v0.9.0"
    ];
    assert.deepEqual(latestTagged(tags, PREFIX), [0, 1, 2]);
    assert.equal(nextVersion(tags, PREFIX, "0.1.0"), "0.1.3");
    assert.equal(nextVersion(tags, "companion-v", "1.0.0"), "3.0.1");
});

test("a version that is not x.y.z is refused rather than guessed at", () => {
    assert.equal(parseVersion("1.2"), null);
    assert.equal(parseVersion("1.2.3-beta"), null);
    assert.throws(() => nextVersion([], PREFIX, "latest"));
    assert.throws(() => manifestVersion("1.2"));
});

test("the manifest carries the version with a fourth part", () => {
    assert.equal(manifestVersion("0.1.4"), "0.1.4.0");
});

test("the script reads tags on stdin and stamps package.json and the manifest", () => {
    const dir = mkdtempSync(join(tmpdir(), "release-version-"));
    const pkg = join(dir, "package.json");
    const manifest = join(dir, "manifest.json");
    writeFileSync(pkg, JSON.stringify({ name: "x", version: "0.1.0" }));
    writeFileSync(manifest, JSON.stringify({ Name: "X", Version: "0.1.0.0" }));

    const next = execFileSync(
        process.execPath,
        [SCRIPT, "next", "--prefix", PREFIX, "--package", pkg],
        {
            input: "streamdeck-v0.1.0\nstreamdeck-v0.1.1\n",
            encoding: "utf8"
        }
    ).trim();
    assert.equal(next, "0.1.2");

    execFileSync(process.execPath, [
        SCRIPT,
        "stamp",
        "--version",
        next,
        "--package",
        pkg,
        "--manifest",
        manifest
    ]);
    assert.equal(JSON.parse(readFileSync(pkg, "utf8")).version, "0.1.2");
    assert.equal(JSON.parse(readFileSync(manifest, "utf8")).Version, "0.1.2.0");
});

test("the Companion module's version constant is stamped, and a missing one fails", () => {
    const source = '/** doc */\nexport const VERSION = "0.1.0";\n';
    assert.equal(stampConstant(source, "0.2.3"), '/** doc */\nexport const VERSION = "0.2.3";\n');
    assert.throws(
        () => stampConstant("export const V = 1;\n", "0.2.3"),
        /no `export const VERSION/
    );
    assert.throws(() => stampConstant(source, "0.2"), /is not x.y.z/);

    const dir = mkdtempSync(join(tmpdir(), "release-version-"));
    const pkg = join(dir, "package.json");
    const file = join(dir, "version.ts");
    writeFileSync(pkg, JSON.stringify({ name: "x", version: "0.1.0" }));
    writeFileSync(file, source);
    execFileSync(process.execPath, [
        SCRIPT,
        "stamp",
        "--version",
        "0.1.7",
        "--package",
        pkg,
        "--constant",
        file
    ]);
    assert.equal(JSON.parse(readFileSync(pkg, "utf8")).version, "0.1.7");
    assert.match(readFileSync(file, "utf8"), /export const VERSION = "0\.1\.7";/);
});
