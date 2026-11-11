/**
 * The issues a Code task can start from: the repository's open ones, never its
 * pull requests, a number read as that issue, and a search held to this
 * repository whatever qualifier is typed into it.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@polaris/db", () => ({ prisma: {} }));

const { listOpenIssues, readIssue } = await import("@/lib/github-service");

const asked: string[] = [];
let reply: unknown = [];

beforeEach(() => {
    asked.length = 0;
    vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string) => {
            asked.push(url);
            return Response.json(reply);
        })
    );
});

afterEach(() => vi.unstubAllGlobals());

describe("a repository's open issues", () => {
    it("lists the recent ones without the pull requests GitHub mixes in", async () => {
        reply = [
            { number: 3, title: "Crash", labels: [{ name: "bug" }], body: "x" },
            { number: 4, title: "A pull request", pull_request: {} }
        ];
        expect(await listOpenIssues("acme", "web", null, "")).toEqual([
            { number: 3, title: "Crash", labels: ["bug"] }
        ]);
        expect(asked[0]).toContain("/repos/acme/web/issues?state=open");
    });

    it("reads a number as that issue", async () => {
        reply = { number: 42, title: "Login", labels: [], body: "Steps", state: "open" };
        expect(await listOpenIssues("acme", "web", null, "#42")).toEqual([
            { number: 42, title: "Login", labels: [], body: "Steps", state: "open" }
        ]);
        expect(asked[0]).toMatch(/\/repos\/acme\/web\/issues\/42$/);
    });

    it("searches this repository only, whatever qualifier is typed", async () => {
        reply = { items: [{ number: 5, title: "Login on Safari", labels: [] }] };
        await listOpenIssues("acme", "web", null, "login repo:other/secret OR org:other");
        const query = decodeURIComponent(new URL(asked[0] ?? "").searchParams.get("q") ?? "");
        expect(query).toBe("repo:acme/web is:issue is:open login");
        asked.length = 0;
        expect(await listOpenIssues("acme", "web", null, "repo:other/secret")).toEqual([]);
        expect(asked).toEqual([]);
    });

    it("is not a pull request read as an issue", async () => {
        reply = { number: 9, title: "PR", pull_request: {} };
        expect(await readIssue("acme", "web", 9, null)).toBeNull();
    });
});
