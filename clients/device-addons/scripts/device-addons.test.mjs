// node --test scripts/device-addons/ - run by .github/workflows/device-addons.yml before publishing.
import test from "node:test";
import { join } from "node:path";
import { asciiJson } from "./json.mjs";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { packagedPath, staleVersions } from "./version-guard.mjs";

const repo = fileURLToPath(new URL("../../../", import.meta.url));

test("the catalog's bytes are ASCII and read back to the same Spanish text", () => {
    const value = { label: { "es-ES": "Lo que hace cada botón", other: "Cómo giran \u{1F39B}" } };
    const text = asciiJson(value);
    assert.match(text, /^[\x20-\x7e]*$/);
    assert.deepEqual(JSON.parse(text), value);
    // Read as Latin-1, the way a reader without a charset does: still the same text.
    assert.deepEqual(JSON.parse(Buffer.from(text, "utf8").toString("latin1")), value);
});

test("every repository add-on's manifest is UTF-8 with no double-encoded text", () => {
    for (const id of readdirSync(join(repo, "clients", "device-addons"), { withFileTypes: true }).filter((item) => item.isDirectory() && existsSync(join(repo, "clients", "device-addons", item.name, "manifest.json"))).map((item) => item.name)) {
        const text = readFileSync(join(repo, "clients", "device-addons", id, "manifest.json"), "utf8");
        assert.doesNotMatch(text, /Ã[\u0080-¿]|�/, `${id}/manifest.json holds double-encoded text`);
    }
});

test("only packaged files count as a change of the package", () => {
    assert.equal(packagedPath("hercules-stream100", "clients/device-addons/hercules-stream100/any/main.cjs"), true);
    assert.equal(packagedPath("hercules-stream100", "clients/device-addons/hercules-stream100/manifest.json"), true);
    assert.equal(packagedPath("hercules-stream100", "crates/polaris-stream100/src/addon.rs"), true);
    assert.equal(packagedPath("hercules-stream100", "clients/device-addons/hercules-stream100/listing.json"), false);
    assert.equal(packagedPath("hercules-stream100", "crates/polaris-stream100/tests/integration.rs"), false);
    assert.equal(packagedPath("hercules-stream100", "clients/device-addons/other/any/main.cjs"), false);
});

test("a package changed under a published version is refused; a raised version passes", () => {
    const published = [{ id: "hercules-stream100", version: "0.1.4" }];
    const changed = ["clients/device-addons/hercules-stream100/any/main.cjs", "docs/device-addons.md"];
    assert.deepEqual(staleVersions([{ id: "hercules-stream100", version: "0.1.4" }], published, changed), [
        { id: "hercules-stream100", version: "0.1.4", touched: ["clients/device-addons/hercules-stream100/any/main.cjs"] }
    ]);
    assert.deepEqual(staleVersions([{ id: "hercules-stream100", version: "0.1.5" }], published, changed), []);
    assert.deepEqual(staleVersions([{ id: "hercules-stream100", version: "0.1.4" }], published, ["docs/device-addons.md"]), []);
    assert.deepEqual(staleVersions([{ id: "new-one", version: "0.1.0" }], published, ["clients/device-addons/new-one/any/main.cjs"]), []);
});
