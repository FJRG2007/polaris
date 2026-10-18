/**
 * Every screen that asks for a file opens the shared picker (Drive, this
 * computer, an address), not the browser's own chooser. A raw
 * `<input type="file">` is allowed only where the picker cannot work, and each
 * of those is listed here with the reason.
 */

import { describe, expect, it } from "vitest";
import { join, relative, resolve } from "node:path";
import { readdirSync, readFileSync, statSync } from "node:fs";

const DASHBOARD = resolve(__dirname, "../../../..");

/** Path from `dashboard/`, and why the browser's chooser stays there. */
const ALLOWED: Record<string, string> = {
    "apps/web/src/components/file-picker/file-picker-dialog.tsx":
        "the picker itself: its 'this computer' tab is the browser's chooser",
    "apps/web/src/app/(app)/drive/files-view.tsx":
        "Drive's own upload: the files are going into Drive, not coming out of it",
    "apps/web/src/app/r/[token]/upload-form.tsx":
        "public upload link: the visitor is not signed in and has no Drive",
    "apps/web/src/app/s/[token]/share-explorer.tsx":
        "public share link: the visitor is not signed in and has no Drive",
    "apps/web/src/app/(app)/chat/composer.tsx":
        "the phone's gallery and camera (capture), which only the browser opens; the paperclip uses the picker",
    "apps/web/src/app/(app)/apps/deploy/upload-source.tsx":
        "a whole folder, which the picker cannot choose; the .zip button uses the picker",
    "apps/web/src/app/(app)/vault/qr-scan.tsx":
        "a 2FA QR carries the secret; the vault reads it only in the browser, and a Drive or address pick is fetched through the server",
    "apps/web/src/app/(app)/vault/recovery-codes.tsx":
        "recovery codes in the clear; the vault reads them only in the browser, and a Drive or address pick is fetched through the server",
    "apps/web/src/app/(app)/vault/settings/vault-import.tsx":
        "a password export in the clear; the vault reads it only in the browser, and a Drive or address pick is fetched through the server",
    "packages/genoffice-pdf/src/renderer/App.tsx":
        "ported editor not mounted in Polaris: no signed-in host to pick from",
    "packages/genoffice-pdf/src/renderer/SignatureDialog.tsx":
        "ported editor not mounted in Polaris: no signed-in host to pick from"
};

const RAW = /type=["{]\s*["']?file["']?\s*}?/;

function sources(dir: string, out: string[] = []): string[] {
    for (const name of readdirSync(dir)) {
        if (name === "node_modules" || name === "dist" || name === ".next") continue;
        const path = join(dir, name);
        if (statSync(path).isDirectory()) sources(path, out);
        else if (path.endsWith(".tsx")) out.push(path);
    }
    return out;
}

function scanned(): string[] {
    const roots: string[] = [];
    for (const group of ["apps", "packages"]) {
        for (const name of readdirSync(join(DASHBOARD, group))) {
            const src = join(DASHBOARD, group, name, "src");
            try {
                if (statSync(src).isDirectory()) roots.push(src);
            } catch {
                // A package with no sources of its own.
            }
        }
    }
    return roots.flatMap((root) => sources(root));
}

describe("raw file inputs", () => {
    const files = scanned();
    const raw = files
        .filter((path) => RAW.test(readFileSync(path, "utf8")))
        .map((path) => relative(DASHBOARD, path).split("\\").join("/"));

    it("scans the dashboard's sources", () => {
        expect(files.length).toBeGreaterThan(100);
    });

    it("opens the shared picker everywhere outside the allowlist", () => {
        expect(raw.filter((path) => !(path in ALLOWED))).toEqual([]);
    });

    it("lists only files that still need the browser's chooser", () => {
        expect(Object.keys(ALLOWED).filter((path) => !raw.includes(path))).toEqual([]);
    });
});
