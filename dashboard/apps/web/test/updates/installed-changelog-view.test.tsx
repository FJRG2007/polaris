// @vitest-environment jsdom

/**
 * The Updates card after an install: what the installed update changed stays
 * on screen beside the update on offer, each under its own range, with no
 * commit in both - and an install with no recorded previous build says so.
 */

import { buildChangelog } from "@polaris/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";

vi.mock("@/components/i18n/i18n-provider", () => ({
    useTranslations: () => Object.assign((key: string) => key, { rich: (key: string) => key })
}));

function changelog(base: string, head: string, commits: { sha: string; message: string }[]) {
    return {
        base,
        head,
        entries: buildChangelog(commits).entries,
        more: 0,
        hidden: 0,
        security: null,
        fixes: [],
        url: `https://github.com/example/repo/compare/${base}...${head}`
    };
}

const installed = vi.hoisted(() => ({ from: "aaaaaaa" as string | null }));
vi.mock("@/app/(app)/admin/updates/actions", () => ({
    installedChangelogAction: async () => ({
        from: installed.from,
        to: "bbbbbbb",
        changelog: installed.from
            ? changelog("aaaaaaa", "bbbbbbb", [{ sha: "1".repeat(40), message: "✨ feat(mail): installed change" }])
            : null
    }),
    updateChangelogAction: async () =>
        changelog("bbbbbbb", "ccccccc", [{ sha: "2".repeat(40), message: "✨ feat(chat): available change" }])
}));

import { UpdateChangelog } from "@/app/(app)/admin/updates/update-changelog";

afterEach(() => {
    cleanup();
    window.sessionStorage.clear();
});

describe("installed and available changelogs", () => {
    it("shows each under its own range without sharing an entry", async () => {
        installed.from = "aaaaaaa";
        render(
            <>
                <UpdateChangelog kind="installed" head="bbbbbbb" />
                <UpdateChangelog head="ccccccc" base="bbbbbbb" />
            </>
        );
        const done = await screen.findByRole("region", { name: "settings.changelog.installedTitle" });
        const offer = screen.getByRole("region", { name: "settings.changelog.title" });
        await within(done).findByText("Installed change");
        await within(offer).findByText("Available change");
        expect(within(done).queryByText("Available change")).toBeNull();
        expect(within(offer).queryByText("Installed change")).toBeNull();
        expect(within(done).getByText("settings.changelog.installedLabel")).toBeTruthy();
        expect(within(done).getByText("aaaaaaa")).toBeTruthy();
        expect(within(offer).getByText("settings.changelog.availableLabel")).toBeTruthy();
        expect(within(offer).getByText("ccccccc")).toBeTruthy();
        expect(done.id).toBe("installed");
    });

    it("says the range is unknown when no previous build was recorded", async () => {
        installed.from = null;
        render(<UpdateChangelog kind="installed" head="bbbbbbb" />);
        expect(await screen.findByText("settings.changelog.installedUnknown")).toBeTruthy();
    });

    it("paints the last answer at once when the range was read before", async () => {
        installed.from = "aaaaaaa";
        const first = render(<UpdateChangelog kind="installed" head="bbbbbbb" />);
        await screen.findByText("Installed change");
        first.unmount();
        render(<UpdateChangelog kind="installed" head="bbbbbbb" />);
        // Synchronously there: no skeleton while the fresh read is under way.
        expect(screen.getByText("Installed change")).toBeTruthy();
    });
});
