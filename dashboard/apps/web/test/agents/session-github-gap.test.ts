/**
 * Starting a session in a repository whose owner lacks Polaris's GitHub App is
 * refused before any row or machine, with the step that fixes it, instead of
 * failing later at the clone.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const REPO = "018f2a3b-4c5d-7e8f-9012-3456789abcde";
const INSTALL = "https://github.com/apps/polaris-agi/installations/new";

let gap: unknown = null;
const created: unknown[] = [];

vi.mock("@/lib/session", () => ({
    requirePermission: async () => ({ id: "user-1", isAdmin: false })
}));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("next/server", () => ({ after: () => undefined }));
vi.mock("@polaris/db", () => ({
    prisma: {
        agentRepo: {
            findFirst: async () => ({ id: REPO, repoFullName: "bytehide/Backend" })
        }
    }
}));
vi.mock("@/lib/i18n/request", () => ({
    getTranslations: async () => (key: string, values?: Record<string, string>) =>
        `${key} ${JSON.stringify(values ?? {})}`
}));
// What the real reach module imports, so its own `installGapMessage` is the one used.
vi.mock("@/lib/github-access", () => ({
    credentialFor: () => null,
    githubCredentialsForUser: async () => []
}));
vi.mock("@/lib/github-service", () => ({ githubAppInstallUrl: async () => null }));
vi.mock("@/lib/github-app-reach", async (original) => ({
    ...(await original<object>()),
    githubInstallGapForRepo: async () => gap
}));
vi.mock("@/lib/agents/session-capacity", () => ({
    capacityRefusal: () => null,
    sessionCapacity: async () => ({}),
    sharedWorkspaceAllowed: async () => false,
    workspaceHolders: async () => [],
    workspaceRefusal: () => null
}));
vi.mock("@/lib/agents/agent-readiness", () => ({
    agentChoicesFor: async () => [],
    agentOptionsFor: async () => []
}));
vi.mock("@/lib/agents/session-service", () => ({
    createSession: async (input: unknown) => {
        created.push(input);
        throw new Error("stop here");
    }
}));
vi.mock("@/lib/agents/session-runtime", () => ({}));
vi.mock("@/lib/tasks/access", () => ({}));
vi.mock("@/lib/tasks/task-detail-service", () => ({}));
vi.mock("@/lib/notifications/notice-words", () => ({}));

const { startSessionAction } = await import("@/app/(app)/apps/agents/sessions/actions");

beforeEach(() => {
    gap = null;
    created.length = 0;
});

describe("starting a session in a repository the App cannot reach", () => {
    it("returns the install step and starts nothing", async () => {
        gap = { kind: "app-missing", owner: "bytehide", url: INSTALL };
        const result = await startSessionAction({ repoId: REPO, title: "Read", cli: "claude" });
        expect(result.githubGap).toEqual(gap);
        expect(result.error).toContain("errors.githubAppMissing");
        expect(result.error).toContain("bytehide");
        expect(result.id).toBeUndefined();
        expect(created).toHaveLength(0);
    });

    it("names the repository missing from a selected-repositories installation", async () => {
        gap = {
            kind: "repo-not-selected",
            owner: "bytehide",
            repository: "bytehide/Backend",
            url: "https://github.com/organizations/bytehide/settings/installations/7"
        };
        const result = await startSessionAction({ repoId: REPO, title: "Read", cli: "claude" });
        expect(result.githubGap).toEqual(gap);
        expect(result.error).toContain("errors.githubRepoNotSelected");
        expect(result.error).toContain("bytehide/Backend");
    });

    it("goes on to create the session when the App is not the problem", async () => {
        await expect(
            startSessionAction({ repoId: REPO, title: "Read", cli: "claude" })
        ).rejects.toThrow("stop here");
        expect(created).toHaveLength(1);
    });
});
