// @vitest-environment jsdom

/**
 * The Code composer's pickers answer from what the page holds: a repository
 * picked from a searched page, or one still being connected from GitHub, is
 * named on the chip at once - never after a read - and the issue list filters
 * the issues already loaded by number or title while GitHub is asked.
 */

import { MessagesWrapper } from "../setup/i18n";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

const { CodeWhereChip, localIssueMatches, rememberRepoName } = await import(
    "@/components/polar/polar-code-context"
);

const CHOICES = {
    sharedWorkspace: false,
    installUrl: null,
    repos: [{ id: "22222222-2222-4222-8222-222222222222", name: "acme/web" }],
    hosts: [],
    agents: [],
    code: { sources: [], personas: [], polarPolicy: { models: [], modelPolicy: "preferred" } }
} as never;

const fetched: string[] = [];

beforeEach(() => {
    fetched.length = 0;
    vi.stubGlobal("fetch", (url: string) => {
        fetched.push(String(url));
        return new Promise<Response>(() => undefined);
    });
});

afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
});

function chip(repoId: string, pendingRepo: string | null = null) {
    return render(
        <MessagesWrapper>
            <CodeWhereChip
                choices={CHOICES}
                repoId={repoId}
                onRepo={() => undefined}
                onRefresh={() => undefined}
                refreshing={false}
                branch=""
                onBranch={() => undefined}
                disabled={false}
                pendingRepo={pendingRepo}
            />
        </MessagesWrapper>
    );
}

describe("the repository chip", () => {
    it("names a repository picked from a searched page the frame it is clicked", () => {
        const id = "33333333-3333-4333-8333-333333333333";
        rememberRepoName(id, "acme/far-away");
        chip(id);
        expect(screen.getByText("acme/far-away")).toBeTruthy();
        // No read for its name: only the branches load behind.
        expect(fetched.some((url) => url.includes("/api/polar/code/repos"))).toBe(false);
    });

    it("names a GitHub repository while it is being connected, and drops back after", () => {
        rememberRepoName("github:acme/new-one", "acme/new-one");
        const view = chip("22222222-2222-4222-8222-222222222222", "github:acme/new-one");
        expect(screen.getByText("acme/new-one")).toBeTruthy();
        view.unmount();
        chip("22222222-2222-4222-8222-222222222222", null);
        expect(screen.getByText("acme/web")).toBeTruthy();
        expect(screen.queryByText("acme/new-one")).toBeNull();
    });
});

describe("the issues already held", () => {
    const ISSUES = [
        { number: 12, title: "Login fails on Safari", labels: ["bug"] },
        { number: 120, title: "Dark mode for settings", labels: [] },
        { number: 7, title: "Safari layout of the login page", labels: [] }
    ];

    it("answers a number with or without #", () => {
        expect(localIssueMatches(ISSUES, "#12").map((item) => item.number)).toEqual([12, 120]);
        expect(localIssueMatches(ISSUES, "7").map((item) => item.number)).toEqual([7]);
    });

    it("answers every word of the title, in any order and case", () => {
        expect(localIssueMatches(ISSUES, "safari LOGIN").map((item) => item.number)).toEqual([12, 7]);
        expect(localIssueMatches(ISSUES, "nothing like it")).toEqual([]);
    });

    it("answers nothing typed with the whole list", () => {
        expect(localIssueMatches(ISSUES, "  ")).toHaveLength(3);
    });
});
