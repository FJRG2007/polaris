// @vitest-environment jsdom

/**
 * The changelog on the Updates card stays compact: Security and New open,
 * everything else folded, a few rows per group before "Show all", and each
 * commit linked from the comparison GitHub returned.
 */

import { buildChangelog } from "@polaris/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

const commits = [
    { sha: "a".repeat(40), message: "🐛 fix(vault): share link expiry\n\nSecurity: high" },
    ...Array.from({ length: 6 }, (_, i) => ({
        sha: `b${i}`.padEnd(40, "0"),
        message: `✨ feat(automations): feature number ${i}`
    })),
    { sha: "c".repeat(40), message: "🐛 fix(chat): unread badge" },
    { sha: "d".repeat(40), message: "🐛 fix(ci): the guards that broke main" }
];

vi.mock("@/components/i18n/i18n-provider", () => ({
    useTranslations: () => Object.assign((key: string) => key, { rich: (key: string) => key })
}));
vi.mock("@/app/(app)/admin/updates/actions", () => ({
    updateChangelogAction: async () => ({
        base: "base",
        head: "head",
        entries: buildChangelog(commits).entries,
        more: 0,
        hidden: 0,
        security: "high",
        fixes: [],
        url: "https://github.com/example/repo/compare/base...head"
    })
}));

import { UpdateChangelog } from "@/app/(app)/admin/updates/update-changelog";

afterEach(cleanup);

describe("UpdateChangelog", () => {
    it("opens Security and New, folds the rest, and links each commit", async () => {
        render(<UpdateChangelog head="head" />);
        await screen.findByText("share link expiry");
        const toggles = screen.getAllByRole("button", { expanded: true });
        expect(toggles.map((button) => button.textContent)).toEqual([
            "settings.changelog.kinds.security1",
            "settings.changelog.kinds.feature6"
        ]);
        expect(screen.queryByText("unread badge")).toBeNull();
        expect(screen.queryByText("the guards that broke main")).toBeNull();
        expect(screen.getAllByText(/feature number/)).toHaveLength(4);
        const sha = screen.getByText("aaaaaaa");
        expect(sha.getAttribute("href")).toBe(`https://github.com/example/repo/commit/${"a".repeat(40)}`);

        fireEvent.click(screen.getByText("settings.changelog.showAll"));
        expect(screen.getAllByText(/feature number/)).toHaveLength(6);

        fireEvent.click(screen.getByRole("button", { name: /kinds\.maintenance/ }));
        expect(screen.getByText("the guards that broke main").getAttribute("title")).toBe(
            "the guards that broke main"
        );
    });
});
