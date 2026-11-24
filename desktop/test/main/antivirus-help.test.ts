/**
 * The antivirus guide, offered where an antivirus looks like the cause: a file
 * the toolchain could not write, and an update that did not install.
 */

import { describe, expect, it, vi } from "vitest";
import { antivirusHelpUrl, antivirusNotice, blockedByAntivirus } from "../../src/main/antivirus-help";

describe("the antivirus guide", () => {
    it("opens in the system's language", () => {
        expect(antivirusHelpUrl("es-ES")).toBe("https://fjrg2007.github.io/polaris/es/docs/antivirus/");
        expect(antivirusHelpUrl("en-US")).toBe("https://fjrg2007.github.io/polaris/en/docs/antivirus/");
        expect(antivirusHelpUrl("fr")).toBe("https://fjrg2007.github.io/polaris/en/docs/antivirus/");
    });

    it("is offered for a blocked file only", () => {
        expect(blockedByAntivirus({ ok: false, code: "blocked" })).toBe(true);
        for (const code of ["offline", "checksum", "disk", "unsupported", "install"]) expect(blockedByAntivirus({ ok: false, code })).toBe(false);
        expect(blockedByAntivirus({ ok: true })).toBe(false);
    });

    it("opens the guide from a click on the toolchain notice", () => {
        const guide = vi.fn();
        const notice = antivirusNotice("toolchain", { guide });
        expect(notice.tag).toBe("antivirus-help");
        expect(notice.title).toMatch(/antivirus/i);
        expect("actions" in notice).toBe(false);
        notice.onClick();
        expect(guide).toHaveBeenCalledTimes(1);
    });

    it("keeps the download page a button away on the update notice", () => {
        const guide = vi.fn();
        const page = vi.fn();
        const notice = antivirusNotice("update", { guide, page }, "0.1.99");
        expect(notice.title).toBe("Polaris 0.1.99 did not install");
        expect(notice.body).toMatch(/antivirus/i);
        // It takes the place of the "is available" notice, not a second one beside it.
        expect(notice.tag).toBe("desktop-update");
        notice.onClick();
        expect(guide).toHaveBeenCalledTimes(1);
        expect(notice.actions).toEqual([{ id: "page", text: "Download page" }]);
        notice.onAction?.("page");
        expect(page).toHaveBeenCalledTimes(1);
    });
});
