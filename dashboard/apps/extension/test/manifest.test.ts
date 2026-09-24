/**
 * What the manifest asks the browser for.
 *
 * Read from the config's own function rather than from a built folder, so this
 * answers for what the next build will ship. Two things are pinned: that an
 * Argon2id vault can be opened at all under manifest v3, and that asking for it
 * did not quietly widen what else may run inside a password manager.
 */

import config from "../wxt.config";
import { describe, expect, it } from "vitest";

type ManifestEnv = { browser: string; manifestVersion: 2 | 3 };

function manifestFor(env: ManifestEnv): Record<string, unknown> {
    const build = config.manifest as unknown as (env: ManifestEnv) => Record<string, unknown>;
    return build(env);
}

function policy(manifest: Record<string, unknown>): string {
    const csp = manifest["content_security_policy"] as { extension_pages?: string } | undefined;
    return csp?.extension_pages ?? "";
}

describe("the Chromium manifest", () => {
    // Without this, `WebAssembly.compile` throws inside the worker and a vault on
    // Argon2id refuses the master password that opens it everywhere else.
    it("allows the WebAssembly an Argon2id vault is opened through", () => {
        expect(policy(manifestFor({ browser: "chrome", manifestVersion: 3 }))).toContain(
            "'wasm-unsafe-eval'"
        );
    });

    it("allows nothing else to run", () => {
        const found = policy(manifestFor({ browser: "chrome", manifestVersion: 3 }));
        // The narrow directive only: `unsafe-eval` would let anything injected
        // into this extension's own pages run as code.
        expect(found).not.toContain("'unsafe-eval'");
        expect(found).not.toContain("unsafe-inline");
        expect(found).toContain("script-src 'self'");
        expect(found).toContain("object-src 'self'");
    });

    it("holds every web page, and nothing that is not one", () => {
        // What puts the list of logins under a login box on every site, the way
        // a password manager's is. Web pages only: no file://, no browser pages.
        const manifest = manifestFor({ browser: "chrome", manifestVersion: 3 });
        expect(manifest["host_permissions"]).toEqual(["https://*/*", "http://*/*"]);
        expect(manifest["optional_host_permissions"]).toBeUndefined();
    });
});

describe("the Firefox manifest", () => {
    // Manifest v2 runs WebAssembly under its own default policy, and the v3
    // spelling of this key is not one v2 reads - so the build that does not need
    // it does not carry it.
    it("carries no content policy of its own", () => {
        expect(manifestFor({ browser: "firefox", manifestVersion: 2 })["content_security_policy"]).toBeUndefined();
    });

    it("keeps the optional list under the name version 2 reads", () => {
        const manifest = manifestFor({ browser: "firefox", manifestVersion: 2 });
        expect(manifest["optional_permissions"]).toEqual(["https://*/*", "http://*/*"]);
        expect(manifest["optional_host_permissions"]).toBeUndefined();
    });
});
