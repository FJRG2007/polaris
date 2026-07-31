/**
 * Whether a connection may register runners is the difference between a clear
 * "add this permission" and a 403 an hour into setting a machine up, so each
 * combination is pinned here - including the fine-grained token, which must be
 * reported as unreadable rather than guessed either way.
 */

import { describe, expect, it } from "vitest";
import {
    evaluateRunnerAccess,
    normalizeRunnerLabels,
    resolveRunnerIsolation,
    runnerName,
    runnerTargetRefusal
} from "../src/runners.js";

describe("evaluateRunnerAccess with a GitHub App", () => {
    it("accepts an installation with repository administration", () => {
        const access = evaluateRunnerAccess({
            method: "app",
            installations: [{ login: "fjrg2007", accountType: "User", permissions: { administration: "write" } }]
        });
        expect(access.ready).toBe(true);
        expect(access.accounts[0]).toMatchObject({ login: "fjrg2007", repo: true, org: false });
        expect(access.advice).toBeNull();
    });

    it("accepts an organization with the narrow runner permission", () => {
        const access = evaluateRunnerAccess({
            method: "app",
            installations: [
                {
                    login: "acme",
                    accountType: "Organization",
                    permissions: { organization_self_hosted_runners: "write" }
                }
            ]
        });
        expect(access.accounts[0]).toMatchObject({ repo: false, org: true });
        expect(access.ready).toBe(true);
    });

    it("does not grant a personal account org-level registration", () => {
        const access = evaluateRunnerAccess({
            method: "app",
            installations: [
                { login: "fjrg2007", accountType: "User", permissions: { organization_self_hosted_runners: "write" } }
            ]
        });
        expect(access.accounts[0]).toMatchObject({ repo: false, org: false });
        expect(access.ready).toBe(false);
    });

    it("treats read-only administration as insufficient", () => {
        const access = evaluateRunnerAccess({
            method: "app",
            installations: [{ login: "fjrg2007", accountType: "User", permissions: { administration: "read" } }]
        });
        expect(access.ready).toBe(false);
        expect(access.advice).toContain("Administration");
    });

    it("says the app is not installed anywhere rather than blaming permissions", () => {
        const access = evaluateRunnerAccess({ method: "app", installations: [] });
        expect(access.ready).toBe(false);
        expect(access.advice).toContain("not installed");
    });
});

describe("evaluateRunnerAccess with a token", () => {
    it("accepts a classic token with the repo scope", () => {
        const access = evaluateRunnerAccess({ method: "pat", patScopes: ["repo", "read:user"] });
        expect(access).toMatchObject({ ready: true, unknown: false, advice: null });
    });

    it("accepts a classic token with admin:org", () => {
        expect(evaluateRunnerAccess({ method: "pat", patScopes: ["admin:org"] }).ready).toBe(true);
    });

    it("refuses a classic token with neither, and says so", () => {
        const access = evaluateRunnerAccess({ method: "pat", patScopes: ["read:user", "gist"] });
        expect(access.ready).toBe(false);
        expect(access.advice).toContain("repo");
    });

    it("reports a fine-grained token as unreadable instead of guessing", () => {
        const access = evaluateRunnerAccess({ method: "pat", patScopes: null });
        expect(access.unknown).toBe(true);
        expect(access.advice).toContain("Administration");
    });
});

describe("evaluateRunnerAccess with nothing connected", () => {
    it("points at the integration rather than at permissions", () => {
        const access = evaluateRunnerAccess({ method: null });
        expect(access.ready).toBe(false);
        expect(access.advice).toContain("Connect GitHub");
    });
});

describe("normalizeRunnerLabels", () => {
    it("lowercases, trims and de-duplicates", () => {
        expect(normalizeRunnerLabels([" Linux ", "linux", "ARM64"])).toEqual(["linux", "arm64"]);
    });

    it("drops empty and absurdly long labels", () => {
        expect(normalizeRunnerLabels(["", "   ", "x".repeat(65), "ok"])).toEqual(["ok"]);
    });
});

describe("runnerTargetRefusal", () => {
    const app = (permissions: Record<string, string>, accountType = "User") =>
        evaluateRunnerAccess({ method: "app", installations: [{ login: "Acme", accountType, permissions }] });

    it("allows a repository pool when administration is granted", () => {
        expect(runnerTargetRefusal(app({ administration: "write" }), "repo", "acme")).toBeNull();
    });

    it("refuses an organization pool held up by the repository permission only", () => {
        const refusal = runnerTargetRefusal(app({ administration: "write" }, "Organization"), "org", "acme");
        expect(refusal).toContain("Self-hosted runners");
    });

    it("refuses a target the app is not installed on", () => {
        expect(runnerTargetRefusal(app({ administration: "write" }), "repo", "somebody-else")).toContain(
            "not installed"
        );
    });

    it("lets a fine-grained token through, since its access cannot be read", () => {
        expect(runnerTargetRefusal(evaluateRunnerAccess({ method: "pat", patScopes: null }), "repo", "acme")).toBeNull();
    });

    it("refuses everything when GitHub is not connected", () => {
        expect(runnerTargetRefusal(evaluateRunnerAccess({ method: null }), "repo", "acme")).toContain("Connect GitHub");
    });
});

describe("resolveRunnerIsolation", () => {
    it("grants containers on a Linux machine whose login can reach the engine", () => {
        const resolved = resolveRunnerIsolation("container", { platform: "linux", containerEngine: true });
        expect(resolved).toMatchObject({ isolation: "container", refusal: null });
    });

    it("refuses containers rather than silently downgrading them", () => {
        const resolved = resolveRunnerIsolation("container", { platform: "linux", containerEngine: false });
        expect(resolved.refusal).toContain("--docker");
        // The point of refusing: nobody is told their jobs are contained when they are not.
        expect(resolved.isolation).toBe("container");
    });

    it("refuses containers on macOS", () => {
        expect(resolveRunnerIsolation("container", { platform: "darwin", containerEngine: true }).refusal).toContain(
            "macOS"
        );
    });

    it("says out loud that a workspace is not a boundary", () => {
        const resolved = resolveRunnerIsolation("workspace", { platform: "linux", containerEngine: true });
        expect(resolved.refusal).toBeNull();
        expect(resolved.note).toContain("not a boundary");
    });
});

describe("runnerName", () => {
    it("builds a name GitHub will accept from a pool name that is not one", () => {
        const name = runnerName("Build & Test (x64)", "0195f0a1-2b3c-7d4e-8f90-1a2b3c4d5e6f");
        expect(name).toBe("polaris-build-test-x64-1a2b3c4d5e6f");
        expect(name.length).toBeLessThanOrEqual(64);
    });

    it("falls back rather than producing a name that is only separators", () => {
        expect(runnerName("---", "0195f0a1-2b3c-7d4e-8f90-1a2b3c4d5e6f")).toBe("polaris-runner-1a2b3c4d5e6f");
    });

    // UUIDv7 leads with a millisecond timestamp, so a pool filling four slots in
    // one pass would hand every runner the same prefix and GitHub would reject all
    // but the first. The suffix has to come off the random end.
    it("is unique across runners created in the same millisecond", () => {
        const first = runnerName("ci", "0195f0a1-2b3c-7d4e-8f90-1a2b3c4d5e6f");
        const second = runnerName("ci", "0195f0a1-2b3c-7d4e-8f90-a0b0c0d0e0f0");
        expect(first).not.toBe(second);
    });

    it("stays inside GitHub's 64-character limit with the longest pool name", () => {
        expect(runnerName("x".repeat(200), "0195f0a1-2b3c-7d4e-8f90-1a2b3c4d5e6f").length).toBeLessThanOrEqual(64);
    });
});
