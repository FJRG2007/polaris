/**
 * The panel that hands a freshly minted set of codes to its owner.
 *
 * Shown at the only moment the codes exist in plaintext - arming the
 * authenticator, or replacing the set - so every code has to be on screen and
 * every way of keeping them has to be next to it. A missing control here is a
 * lockout later, which is why the ways out are pinned rather than assumed.
 *
 * The formats behind the Download menu are Radix content and do not render
 * until it is opened; what each one produces is covered by backup-codes.test.ts,
 * which parses the PDF back with a real reader.
 */

import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { BACKUP_CODE_FORMATS } from "../../src/lib/backup-codes";
import { BackupCodesPanel } from "../../src/app/(app)/account/security/backup-codes-panel";

const CODES = ["B6GJZ-AfzDS", "gQy1M-ahWSm", "jBraT-pRqKr"];

describe("the backup codes panel", () => {
    it("shows every code it was given", () => {
        const markup = renderToStaticMarkup(<BackupCodesPanel codes={CODES} />);
        for (const code of CODES) expect(markup).toContain(code);
    });

    it("offers all three ways of keeping them", () => {
        const markup = renderToStaticMarkup(<BackupCodesPanel codes={CODES} />);
        expect(markup).toContain("Copy");
        expect(markup).toContain("Download");
        expect(markup).toContain("Print");
    });

    it("says the codes are not shown again, since they are not", () => {
        const markup = renderToStaticMarkup(<BackupCodesPanel codes={CODES} />);
        expect(markup).toContain("not shown again");
    });

    it("takes a caller's wording when the moment needs different words", () => {
        const markup = renderToStaticMarkup(<BackupCodesPanel codes={CODES} label="Keep these somewhere safe." />);
        expect(markup).toContain("Keep these somewhere safe.");
        expect(markup).not.toContain("not shown again");
    });

    it("downloads in the formats a person actually has a use for", () => {
        // Plain text to paste into a password manager, and a PDF to file or
        // print. The menu's own items are Radix content; this pins the list they
        // are built from.
        const formats = BACKUP_CODE_FORMATS.map((entry) => entry.format);
        expect(formats).toContain("txt");
        expect(formats).toContain("pdf");
    });
});
