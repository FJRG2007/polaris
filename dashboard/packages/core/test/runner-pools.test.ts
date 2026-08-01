/**
 * The pool form is the only place an operator says whose workflows a machine gets
 * offered to, and every owner and repository in that answer ends up in a REST path.
 * These pin the rejections rather than the acceptances: a schema nobody has watched
 * refuse anything is not a schema.
 */

import { describe, expect, it } from "vitest";
import { createRunnerPoolSchema, updateRunnerPoolSchema } from "../src/schemas/runners.js";

const valid = {
    serverId: "0195f0a1-2b3c-7d4e-8f90-1a2b3c4d5e6f",
    name: "Build",
    scope: { kind: "repo" as const, owner: "fjrg2007", repo: "polaris" },
    labels: ["self-hosted"],
    maxConcurrent: 2,
    isolation: "container" as const
};

describe("createRunnerPoolSchema", () => {
    it("accepts a repository pool", () => {
        const parsed = createRunnerPoolSchema.parse(valid);
        expect(parsed.scope).toEqual({ kind: "repo", owner: "fjrg2007", repo: "polaris" });
        expect(parsed.maxConcurrent).toBe(2);
    });

    it("refuses a repository scope with no repository", () => {
        expect(createRunnerPoolSchema.safeParse({ ...valid, scope: { kind: "repo", owner: "acme" } }).success).toBe(
            false
        );
    });

    it("accepts an organization scope, which names no repository", () => {
        expect(createRunnerPoolSchema.safeParse({ ...valid, scope: { kind: "org", owner: "acme" } }).success).toBe(true);
    });

    it("accepts a list of repositories and an account", () => {
        const picked = createRunnerPoolSchema.parse({
            ...valid,
            scope: { kind: "repos", repos: [{ owner: "acme", repo: "web" }, { owner: "acme", repo: "api" }] }
        });
        expect(picked.scope).toMatchObject({ kind: "repos" });
        expect(createRunnerPoolSchema.safeParse({ ...valid, scope: { kind: "account", owner: "acme" } }).success).toBe(
            true
        );
    });

    it("refuses an empty pick, which would be a pool that serves nothing", () => {
        expect(createRunnerPoolSchema.safeParse({ ...valid, scope: { kind: "repos", repos: [] } }).success).toBe(false);
        expect(createRunnerPoolSchema.safeParse({ ...valid, scope: { kind: "users", userIds: [] } }).success).toBe(
            false
        );
    });

    it("takes Polaris people by id, never by a login typed on their behalf", () => {
        const parsed = createRunnerPoolSchema.parse({
            ...valid,
            scope: { kind: "users", userIds: [valid.serverId], logins: ["somebody-else"] }
        });
        expect(parsed.scope).toEqual({ kind: "users", userIds: [valid.serverId] });
        expect(createRunnerPoolSchema.safeParse({ ...valid, scope: { kind: "users", userIds: ["fjrg2007"] } }).success)
            .toBe(false);
    });

    it("refuses a scope kind it does not know", () => {
        expect(createRunnerPoolSchema.safeParse({ ...valid, scope: { kind: "everything" } }).success).toBe(false);
    });

    it.each([
        ["a path traversal", "../../orgs"],
        ["a trailing hyphen", "acme-"],
        ["a leading hyphen", "-acme"],
        ["consecutive hyphens", "ac--me"],
        ["a slash", "acme/polaris"],
        ["nothing", "   "]
    ])("refuses %s as an account", (_case, owner) => {
        expect(createRunnerPoolSchema.safeParse({ ...valid, scope: { kind: "account", owner } }).success).toBe(false);
    });

    it.each([
        ["a path traversal", "../secrets"],
        ["a slash", "owner/repo"],
        ["a space", "my repo"]
    ])("refuses %s as a repository", (_case, repo) => {
        expect(
            createRunnerPoolSchema.safeParse({ ...valid, scope: { kind: "repo", owner: "acme", repo } }).success
        ).toBe(false);
    });

    it("normalizes labels the way GitHub does", () => {
        expect(createRunnerPoolSchema.parse({ ...valid, labels: [" Self-Hosted ", "self-hosted", "GPU"] }).labels)
            .toEqual(["self-hosted", "gpu"]);
    });

    it("refuses a pool no workflow could ever select", () => {
        expect(createRunnerPoolSchema.safeParse({ ...valid, labels: ["  "] }).success).toBe(false);
    });

    it("caps how many processes one pool may start on a machine", () => {
        expect(createRunnerPoolSchema.safeParse({ ...valid, maxConcurrent: 99 }).success).toBe(false);
        expect(createRunnerPoolSchema.safeParse({ ...valid, maxConcurrent: 0 }).success).toBe(false);
    });

    it("has no way to ask for a runner that outlives its job", () => {
        const parsed = createRunnerPoolSchema.parse({ ...valid, ephemeral: false, persistent: true });
        expect(parsed).not.toHaveProperty("ephemeral");
        expect(parsed).not.toHaveProperty("persistent");
    });
});

describe("consumption limits", () => {
    it("means unlimited by absence, and never zero", () => {
        expect(createRunnerPoolSchema.parse(valid).limits).toEqual({
            perTargetConcurrent: null,
            minutesBudget: null,
            minutesWindow: "month",
            jobsPerDay: null,
            onExhausted: "pause"
        });
        expect(createRunnerPoolSchema.safeParse({ ...valid, limits: { minutesBudget: 0 } }).success).toBe(false);
        expect(createRunnerPoolSchema.safeParse({ ...valid, limits: { jobsPerDay: 0 } }).success).toBe(false);
    });

    it("keeps a per-repository ceiling within what the pool itself may run", () => {
        expect(createRunnerPoolSchema.safeParse({ ...valid, limits: { perTargetConcurrent: 99 } }).success).toBe(false);
    });

    it("takes a window and an action, and refuses ones it does not know", () => {
        const parsed = createRunnerPoolSchema.parse({
            ...valid,
            limits: { minutesBudget: 600, minutesWindow: "day", onExhausted: "warn" }
        });
        expect(parsed.limits).toMatchObject({ minutesBudget: 600, minutesWindow: "day", onExhausted: "warn" });
        expect(createRunnerPoolSchema.safeParse({ ...valid, limits: { minutesWindow: "week" } }).success).toBe(false);
        expect(createRunnerPoolSchema.safeParse({ ...valid, limits: { onExhausted: "bill" } }).success).toBe(false);
    });
});

describe("the server a pool runs on", () => {
    it("accepts the box Polaris runs on", () => {
        expect(createRunnerPoolSchema.parse({ ...valid, serverId: "local" }).serverId).toBe("local");
    });

    it.each([
        ["a name that is not an id", "lirio-0"],
        ["a path traversal", "../local"],
        ["nothing", ""]
    ])("refuses %s as a server", (_case, serverId) => {
        expect(createRunnerPoolSchema.safeParse({ ...valid, serverId }).success).toBe(false);
    });
});

describe("updateRunnerPoolSchema", () => {
    it("cannot move a pool to another machine", () => {
        const parsed = updateRunnerPoolSchema.parse({ id: valid.serverId, name: "Renamed", serverId: "local" });
        expect(parsed).not.toHaveProperty("serverId");
    });

    it("holds a changed scope to the same rules as a new one", () => {
        expect(
            updateRunnerPoolSchema.safeParse({ id: valid.serverId, scope: { kind: "repo", owner: "acme-" } }).success
        ).toBe(false);
    });

    it("leaves absent fields absent rather than defaulting them", () => {
        expect(updateRunnerPoolSchema.parse({ id: valid.serverId })).toEqual({ id: valid.serverId });
    });
});
