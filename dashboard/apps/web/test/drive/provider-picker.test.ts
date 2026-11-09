/**
 * The storage provider picker's data: every kind reachable, every brand mark a
 * file that exists, and a search that finds a provider by the words people use.
 */

import { join } from "node:path";
import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { matchProviders, PROVIDERS } from "@/app/(app)/drive/provider-picker";

const words = (kind: string) => (kind === "gdrive" ? "Google Drive Unidad" : kind);

describe("provider picker", () => {
    it("offers every connectable kind exactly once", () => {
        const kinds = PROVIDERS.map((entry) => entry.kind);
        expect(new Set(kinds).size).toBe(kinds.length);
        expect(kinds).toEqual(expect.arrayContaining(["unifi-unas", "local", "sftp", "smb", "nfs", "webdav", "s3", "gdrive", "onedrive", "dropbox", "synology", "qnap", "truenas"]));
    });

    it("points every brand mark at a file that ships, and gives the rest an icon", () => {
        for (const entry of PROVIDERS) {
            if (entry.logo) expect(existsSync(join(process.cwd(), "public", entry.logo)), entry.logo).toBe(true);
            else expect(entry.icon, entry.kind).toBeDefined();
        }
    });

    it("finds providers by name, keyword and accent-free text, and nothing for nonsense", () => {
        expect(matchProviders("", words)).toHaveLength(PROVIDERS.length);
        expect(matchProviders("aws", words).map((entry) => entry.kind)).toEqual(["s3"]);
        expect(matchProviders("SSH", words).map((entry) => entry.kind)).toEqual(["sftp"]);
        expect(matchProviders("unidad", words).map((entry) => entry.kind)).toEqual(["gdrive"]);
        expect(matchProviders("nas", words).map((entry) => entry.kind)).toEqual(["unifi-unas", "synology", "qnap", "truenas"]);
        expect(matchProviders("zzzz", words)).toHaveLength(0);
    });
});
