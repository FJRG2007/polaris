/**
 * The pool form is the only place an operator says which GitHub account Polaris
 * should offer a machine to, and both halves of that answer end up in a REST path.
 * These pin the rejections rather than the acceptances: a schema nobody has
 * watched refuse anything is not a schema.
 */

import { describe, expect, it } from "vitest";
import { createRunnerPoolSchema, updateRunnerPoolSchema } from "../src/schemas/runners.js";

const valid = {
    hostId: "0195f0a1-2b3c-7d4e-8f90-1a2b3c4d5e6f",
    name: "Build",
    scope: "repo" as const,
    targetOwner: "fjrg2007",
    targetRepo: "polaris",
    labels: ["self-hosted"],
    maxConcurrent: 2,
    isolation: "container" as const
};

describe("createRunnerPoolSchema", () => {
    it("accepts a repository pool", () => {
        const parsed = createRunnerPoolSchema.parse(valid);
        expect(parsed).toMatchObject({ scope: "repo", targetRepo: "polaris", maxConcurrent: 2 });
    });

    it("requires the repository when the scope is a repository", () => {
        const parsed = createRunnerPoolSchema.safeParse({ ...valid, targetRepo: undefined });
        expect(parsed.success).toBe(false);
        expect(parsed.error?.issues[0]?.path).toEqual(["targetRepo"]);
    });

    it("accepts an organization pool without one", () => {
        expect(createRunnerPoolSchema.safeParse({ ...valid, scope: "org", targetRepo: undefined }).success).toBe(true);
    });

    it.each([
        ["a path traversal", "../../orgs"],
        ["a trailing hyphen", "acme-"],
        ["a leading hyphen", "-acme"],
        ["consecutive hyphens", "ac--me"],
        ["a slash", "acme/polaris"],
        ["nothing", "   "]
    ])("refuses %s as an account", (_case, targetOwner) => {
        expect(createRunnerPoolSchema.safeParse({ ...valid, targetOwner }).success).toBe(false);
    });

    it.each([
        ["a path traversal", "../secrets"],
        ["a slash", "owner/repo"],
        ["a space", "my repo"]
    ])("refuses %s as a repository", (_case, targetRepo) => {
        expect(createRunnerPoolSchema.safeParse({ ...valid, targetRepo }).success).toBe(false);
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

describe("updateRunnerPoolSchema", () => {
    it("cannot move a pool to another target", () => {
        const parsed = updateRunnerPoolSchema.parse({
            id: valid.hostId,
            name: "Renamed",
            targetOwner: "somebody-else",
            scope: "org"
        });
        expect(parsed).not.toHaveProperty("targetOwner");
        expect(parsed).not.toHaveProperty("scope");
    });

    it("leaves absent fields absent rather than defaulting them", () => {
        expect(updateRunnerPoolSchema.parse({ id: valid.hostId })).toEqual({ id: valid.hostId });
    });
});
