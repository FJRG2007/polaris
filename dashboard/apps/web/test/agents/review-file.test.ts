/**
 * The repository's `.polaris/review.yaml`: read at the ref asked for with a
 * read-only token for that one repository, laid over the saved tiers when a tier
 * points at it, and ignored - never fatal - when it is missing or broken.
 */

import * as core from "@polaris/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ token: vi.fn(), tiers: vi.fn() }));

vi.mock("@polaris/db", () => ({ prisma: {} }));
vi.mock("@/lib/github-service", () => ({ githubAppInstallationToken: mocks.token }));
vi.mock("@/lib/agents/agent-defaults-service", () => ({ savedReviewTiers: mocks.tiers }));

import { readReviewFile, reviewSettingsFor } from "@/lib/agents/review-gate";

const fetchMock = vi.fn();
const repo = { ownerId: "owner-1", repoFullName: "acme/app", review: null };

beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("fetch", fetchMock);
    mocks.token.mockResolvedValue("token-1");
    mocks.tiers.mockResolvedValue([core.INHERIT_REVIEW]);
});

afterEach(() => vi.unstubAllGlobals());

describe("readReviewFile", () => {
    it("reads the file at the ref with a token scoped to the repository", async () => {
        fetchMock.mockResolvedValue(new Response("drafts: true\nignore_authors:\n  - renovate[bot]\n"));
        const read = await readReviewFile("acme/app", "feature/x");
        expect(read).toMatchObject({ drafts: true, ignoreAuthors: ["renovate[bot]"] });
        expect(mocks.token).toHaveBeenCalledWith("acme", {
            repositories: ["app"],
            permissions: { contents: "read" }
        });
        expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
            "https://api.github.com/repos/acme/app/contents/.polaris/review.yaml?ref=feature%2Fx"
        );
    });

    it("answers null for a missing file, broken YAML, or no token", async () => {
        fetchMock.mockResolvedValue(new Response("", { status: 404 }));
        expect(await readReviewFile("acme/app", "main")).toBeNull();
        fetchMock.mockResolvedValue(new Response("drafts: [unclosed"));
        expect(await readReviewFile("acme/app", "main")).toBeNull();
        mocks.token.mockResolvedValue(null);
        expect(await readReviewFile("acme/app", "main")).toBeNull();
    });
});

describe("reviewSettingsFor", () => {
    it("does not touch GitHub while the settings are Polaris's own", async () => {
        expect((await reviewSettingsFor(repo, { defaultBranch: "main", head: "abc" })).drafts).toBe(false);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it("lays the file from the chosen ref over the saved tiers", async () => {
        mocks.tiers.mockResolvedValue([{ ...core.INHERIT_REVIEW, configSource: "branch", incremental: true }]);
        fetchMock.mockResolvedValue(new Response("drafts: true\n"));
        const resolved = await reviewSettingsFor(repo, { defaultBranch: "main", head: "abc" });
        expect(resolved).toMatchObject({ drafts: true, incremental: true, configSource: "branch" });
        expect(String(fetchMock.mock.calls[0]?.[0])).toContain("?ref=abc");
    });

    it("falls back to the saved tiers when the file is missing", async () => {
        mocks.tiers.mockResolvedValue([{ ...core.INHERIT_REVIEW, configSource: "repo", drafts: true }]);
        fetchMock.mockResolvedValue(new Response("", { status: 404 }));
        const resolved = await reviewSettingsFor(repo, { defaultBranch: "main", head: "abc" });
        expect(resolved.drafts).toBe(true);
        expect(String(fetchMock.mock.calls[0]?.[0])).toContain("?ref=main");
    });
});
