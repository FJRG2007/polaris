// The published app catalogue's writer (scripts/app-catalog.mjs): what it lists,
// and that metadata the dashboard would refuse stops the publish.
import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, verify } from "node:crypto";
import { buildCatalog, catalogEntry, signatureFile } from "../app-catalog.mjs";

const bundle = { file: "bakery.zip", digest: `sha256:${"b".repeat(64)}`, size: 2048, manifest: `sha256:${"c".repeat(64)}` };
const about = {
    minPolaris: "0.1.140",
    name: { "en-US": "Bakery" },
    summary: { "en-US": "Run a bakery." },
    description: { "en-US": "Orders and ovens." }
};
const pkg = (catalog = about, extra = {}) => ({ name: "@polaris-app/bakery", version: "1.2.3", polaris: { id: "bakery", ...extra, catalog } });
const ISSUED = "2026-11-28T00:00:00.000Z";

test("lists only the apps that opt in, with the bundle the build published", () => {
    const other = { name: "@polaris-app/other", version: "1.0.0", polaris: { id: "other" } };
    const listed = JSON.parse(buildCatalog([pkg(), other], { apps: { bakery: bundle } }, "1.2", ISSUED).toString("utf8"));
    assert.equal(listed.kind, "apps");
    assert.deepEqual(listed.apps.map((app) => app.id), ["bakery"]);
    assert.deepEqual(listed.apps[0].bundle, { file: "bakery.zip", digest: bundle.digest, size: 2048 });
    assert.equal(listed.apps[0].hostApi, "1.2");
});

test("takes the app's own host API over the default", () => {
    assert.equal(catalogEntry(pkg(about, { hostApi: "1.3" }), bundle, "1.2", ISSUED).hostApi, "1.3");
});

test("stops the publish on an app it could not list correctly", () => {
    assert.throws(() => catalogEntry(pkg(), undefined, "1.2", ISSUED), /bundle index/);
    assert.throws(() => catalogEntry(pkg({ ...about, minPolaris: "soon" }), bundle, "1.2", ISSUED), /minPolaris/);
    assert.equal(catalogEntry(pkg({ ...about, minPolaris: undefined }), bundle, "1.2", ISSUED).minPolaris, undefined);
    assert.throws(() => catalogEntry(pkg({ ...about, name: {} }), bundle, "1.2", ISSUED), /name/);
});

test("signs the exact bytes, in the plugin catalog's signature shape", () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const bytes = buildCatalog([pkg()], { apps: { bakery: bundle } }, "1.2", ISSUED);
    const sig = JSON.parse(signatureFile(bytes, privateKey.export({ format: "pem", type: "pkcs8" })));
    assert.equal(sig.keyId, "addons-2026-11");
    assert.ok(verify(null, bytes, publicKey, Buffer.from(sig.signature, "base64")));
});
