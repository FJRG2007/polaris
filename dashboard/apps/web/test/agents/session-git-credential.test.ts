/**
 * The token a session's git is handed: the person's GitHub App user token when
 * they signed in to GitHub through the App and that link reaches the
 * repository, the App installation's otherwise - and never written to a log.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const store = vi.hoisted(() => ({
    list: vi.fn(),
    read: vi.fn(),
    update: vi.fn()
}));
const github = vi.hoisted(() => ({
    installation: vi.fn(),
    refresh: vi.fn(),
    access: vi.fn()
}));
const sessions = vi.hoisted(() => ({
    forToken: vi.fn(),
    repository: vi.fn(),
    starter: vi.fn()
}));

vi.mock("@/lib/connections/store", () => ({
    listConnections: store.list,
    readCredential: store.read,
    updateCredential: store.update
}));
vi.mock("@/lib/connections/health", () => ({ noteConnectionRefused: vi.fn() }));
vi.mock("@/lib/github-service", () => ({
    cloneAuthHeader: vi.fn(),
    githubAppInstallationToken: github.installation,
    listReposForPat: vi.fn(),
    listReposForUserToken: vi.fn(),
    refreshGithubUserToken: github.refresh,
    repoAccessFor: github.access,
    resolveGithubRepo: vi.fn()
}));
vi.mock("@/lib/agents/session-service", () => ({
    sessionForToken: sessions.forToken,
    sessionRepository: sessions.repository,
    sessionStarter: sessions.starter
}));

import { POST } from "@/app/api/agents/sessions/[id]/git-credential/route";

const USER_TOKEN = "ghu_person_token_value";
const RENEWED = "ghu_renewed_token_value";
const PAT = "ghp_pasted_token_value";
const INSTALLATION = "ghs_installation_token_value";

function ask(tool?: string): Promise<Response> {
    const url = `https://polaris.example.test/api/agents/sessions/s1/git-credential${tool ? `?tool=${tool}` : ""}`;
    return POST(new Request(url, { method: "POST", headers: { authorization: "Bearer session-token" } }), {
        params: Promise.resolve({ id: "s1" })
    });
}

function link(id: string, label: string, method: "oauth" | "token") {
    return { id, label, method, accountId: "1" };
}

let logged: string[] = [];

beforeEach(() => {
    for (const mock of [...Object.values(store), ...Object.values(github), ...Object.values(sessions)])
        mock.mockReset();
    sessions.forToken.mockResolvedValue({ id: "s1", state: "running", taskId: null, cli: "claude" });
    sessions.repository.mockResolvedValue("acme/widgets");
    sessions.starter.mockResolvedValue("user-1");
    github.installation.mockResolvedValue(INSTALLATION);
    github.access.mockResolvedValue("reachable");
    logged = [];
    for (const level of ["log", "info", "warn", "error", "debug"] as const) {
        vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
            logged.push(args.map((arg) => (arg instanceof Error ? `${arg.message} ${arg.stack}` : String(arg))).join(" "));
        });
    }
});

afterEach(() => {
    vi.restoreAllMocks();
    // Whatever happened in the test, no token reached a log line.
    for (const line of logged) {
        for (const token of [USER_TOKEN, RENEWED, PAT, INSTALLATION]) expect(line).not.toContain(token);
    }
});

describe("the session git credential", () => {
    it("hands out the person's App user token when their link reaches the repository", async () => {
        store.list.mockResolvedValue([link("c1", "acme", "oauth")]);
        store.read.mockResolvedValue({ accessToken: USER_TOKEN, expiresAt: Date.now() + 60_000 });
        const response = await ask();
        expect(response.status).toBe(200);
        expect(await response.text()).toBe(`username=x-access-token\npassword=${USER_TOKEN}\n`);
        expect(github.access).toHaveBeenCalledWith("acme", "widgets", USER_TOKEN);
        expect(github.installation).not.toHaveBeenCalled();
    });

    it("does the same for the session's gh", async () => {
        store.list.mockResolvedValue([link("c1", "acme", "oauth")]);
        store.read.mockResolvedValue({ accessToken: USER_TOKEN });
        expect(await (await ask("gh")).text()).toContain(`password=${USER_TOKEN}`);
        expect(github.installation).not.toHaveBeenCalled();
    });

    it("prefers the link for the repository's owner", async () => {
        store.list.mockResolvedValue([link("c1", "someone", "oauth"), link("c2", "acme", "oauth")]);
        store.read.mockImplementation(async (id: string) => ({ accessToken: id === "c2" ? USER_TOKEN : "ghu_other" }));
        expect(await (await ask()).text()).toContain(`password=${USER_TOKEN}`);
        expect(github.access).toHaveBeenCalledTimes(1);
    });

    it("refreshes a user token that has expired, and stores the new one", async () => {
        store.list.mockResolvedValue([link("c1", "acme", "oauth")]);
        store.read.mockResolvedValue({ accessToken: USER_TOKEN, refreshToken: "ghr_refresh", expiresAt: Date.now() - 1 });
        github.refresh.mockResolvedValue({ accessToken: RENEWED, refreshToken: "ghr_next", expiresAt: Date.now() + 8 * 3600_000 });
        expect(await (await ask()).text()).toContain(`password=${RENEWED}`);
        expect(github.refresh).toHaveBeenCalledWith("ghr_refresh");
        expect(store.update).toHaveBeenCalledWith("c1", expect.objectContaining({ accessToken: RENEWED, refreshToken: "ghr_next" }));
    });

    it("never hands out a pasted personal token", async () => {
        store.list.mockResolvedValue([link("c1", "acme", "token")]);
        store.read.mockResolvedValue({ token: PAT });
        const text = await (await ask()).text();
        expect(text).toContain(`password=${INSTALLATION}`);
        expect(text).not.toContain(PAT);
    });

    it("falls back to the installation token when nothing is linked", async () => {
        store.list.mockResolvedValue([]);
        expect(await (await ask()).text()).toContain(`password=${INSTALLATION}`);
        expect(github.installation).toHaveBeenCalledWith("acme", {
            repositories: ["widgets"],
            permissions: { contents: "write" }
        });
    });

    it("falls back when the person's link cannot see the repository", async () => {
        store.list.mockResolvedValue([link("c1", "acme", "oauth")]);
        store.read.mockResolvedValue({ accessToken: USER_TOKEN });
        github.access.mockResolvedValue("out-of-reach");
        expect(await (await ask()).text()).toContain(`password=${INSTALLATION}`);
    });

    it("falls back silently when the refresh is refused or the store fails", async () => {
        store.list.mockResolvedValue([link("c1", "acme", "oauth")]);
        store.read.mockResolvedValue({ accessToken: USER_TOKEN, refreshToken: "ghr_refresh", expiresAt: Date.now() - 1 });
        github.refresh.mockRejectedValue(new Error(`refused ${USER_TOKEN}`));
        expect(await (await ask()).text()).toContain(`password=${INSTALLATION}`);
        store.list.mockRejectedValue(new Error("database down"));
        expect(await (await ask()).text()).toContain(`password=${INSTALLATION}`);
        expect(logged).toEqual([]);
    });

    it("falls back for a session nobody started", async () => {
        sessions.starter.mockResolvedValue(null);
        expect(await (await ask()).text()).toContain(`password=${INSTALLATION}`);
        expect(store.list).not.toHaveBeenCalled();
    });

    it("still refuses a token that names another session", async () => {
        sessions.forToken.mockResolvedValue({ id: "s2", state: "running", taskId: null, cli: "claude" });
        const response = await ask();
        expect(response.status).toBe(401);
        expect(await response.text()).toBe("");
    });
});
