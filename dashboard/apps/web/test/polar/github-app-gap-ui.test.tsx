// @vitest-environment jsdom
/**
 * The step under an answer whose repository read the GitHub App refused: the
 * install button opens the App's page in a new tab, and Check again asks again.
 * Also the Polar prompt rules that make the model relay it instead of guessing.
 */

import { MessagesWrapper } from "../setup/i18n";
import { polarSystemPrompt } from "@/lib/polar/prompt";
import { aboutRepository } from "@/lib/polar/code-host";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GithubAppGapNotice, gapsOf } from "@/components/github-app-gap";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

afterEach(cleanup);

const INSTALL = "https://github.com/apps/polaris-agi/installations/new";

describe("the install notice", () => {
    it("links the App's install page in a new tab and offers Check again", () => {
        const again = vi.fn();
        render(
            <MessagesWrapper>
                <GithubAppGapNotice
                    gap={{ kind: "app-missing", owner: "bytehide", url: INSTALL }}
                    onCheckAgain={again}
                />
            </MessagesWrapper>
        );
        const link = screen.getByRole("link", { name: "Install Polaris on bytehide" });
        expect(link.getAttribute("href")).toBe(INSTALL);
        expect(link.getAttribute("target")).toBe("_blank");
        expect(link.getAttribute("rel")).toContain("noopener");
        expect(screen.getByText("Polaris is not installed on bytehide")).toBeTruthy();
        fireEvent.click(screen.getByRole("button", { name: "Check again" }));
        expect(again).toHaveBeenCalledOnce();
    });

    it("links the installation to add a repository to", () => {
        const url = "https://github.com/organizations/bytehide/settings/installations/7";
        render(
            <MessagesWrapper>
                <GithubAppGapNotice
                    gap={{
                        kind: "repo-not-selected",
                        owner: "bytehide",
                        repository: "bytehide/Backend",
                        url
                    }}
                />
            </MessagesWrapper>
        );
        expect(
            screen.getByRole("link", { name: "Choose repositories" }).getAttribute("href")
        ).toBe(url);
        expect(screen.queryByRole("button", { name: "Check again" })).toBeNull();
    });

    it("draws one notice per owner from a turn's results, ignoring anything else", () => {
        const gap = { kind: "app-missing", owner: "bytehide", url: INSTALL };
        expect(
            gapsOf([
                { ok: false, access: gap },
                { ok: false, access: { ...gap, owner: "ByteHide" } },
                { ok: true, text: "x" },
                { ok: false, access: { kind: "app-missing", owner: 3 } },
                null
            ])
        ).toHaveLength(1);
    });
});

describe("Polar's rules for repositories", () => {
    it("tells the model to read first, relay the App's reason, and never open a session to read", () => {
        const prompt = polarSystemPrompt("Ana", null, "", true);
        expect(prompt).toContain("call the repo_ tools first");
        expect(prompt).toContain("Never say you cannot reach a repository without having tried them");
        expect(prompt).toContain("Polaris GitHub app is not installed");
        expect(prompt).toContain("Never propose starting an Agents session to read a repository");
    });

    it("says web reading is off instead of guessing when it is", () => {
        const prompt = polarSystemPrompt("Ana", null, "", false);
        expect(prompt).toContain("reading the web is off for this chat instead of guessing");
        expect(prompt).not.toContain("repo_ tools first");
    });

    it("offers the repository tools on a branch page shared by the extension", () => {
        expect(aboutRepository("https://github.com/bytehide/Backend/tree/develop", [])).toBe(true);
        expect(aboutRepository("https://github.com/bytehide/Backend", [])).toBe(true);
        expect(aboutRepository("https://github.com/settings/profile", [])).toBe(false);
    });
});
