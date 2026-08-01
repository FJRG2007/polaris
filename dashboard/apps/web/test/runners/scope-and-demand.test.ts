/**
 * Two decisions a pool makes before it starts anything, both of which are wrong in
 * ways that are quiet rather than loud.
 *
 * A stored scope that cannot be read must not take a reconcile pass down - the row
 * is written by one version of Polaris and read by the next. And a pool that
 * believes it can take a job it has no label for records demand it will never
 * satisfy, which looks exactly like a pool that is broken.
 */

import { describe, expect, it } from "vitest";
import { servesLabels } from "@/lib/runners/runner-labels";
import { parseStoredScope, storeScope, targetKey } from "@/lib/runners/runner-scope";

describe("parseStoredScope", () => {
    it("reads back what was stored, for every kind", () => {
        expect(parseStoredScope("repo", JSON.stringify({ owner: "acme", repo: "web" }))).toEqual({
            kind: "repo",
            owner: "acme",
            repo: "web"
        });
        expect(parseStoredScope("org", JSON.stringify({ owner: "acme" }))).toEqual({ kind: "org", owner: "acme" });
        expect(parseStoredScope("group", JSON.stringify({ groupId: "0195f0a1-2b3c-7d4e-8f90-1a2b3c4d5e6f" })))
            .toMatchObject({ kind: "group" });
    });

    it("refuses a scope whose body does not match its kind", () => {
        // The column says "repo" and the body has no repository: storing this would
        // have produced a REST path with an empty segment.
        expect(parseStoredScope("repo", JSON.stringify({ owner: "acme" }))).toBeNull();
        expect(parseStoredScope("group", JSON.stringify({ groupId: "not-an-id" }))).toBeNull();
    });

    it("survives a column holding something that is not a scope at all", () => {
        expect(parseStoredScope("repo", "not json")).toBeNull();
        expect(parseStoredScope("elsewhere", "{}")).toBeNull();
        expect(parseStoredScope("repo", "null")).toBeNull();
    });
});

describe("storeScope", () => {
    it("round-trips through the two columns it is kept in", () => {
        const scope = { kind: "repos" as const, repos: [{ owner: "acme", repo: "web" }] };
        const stored = storeScope(scope);
        expect(stored.scope).toBe("repos");
        expect(parseStoredScope(stored.scope, stored.scopeConfig)).toEqual(scope);
    });
});

describe("targetKey", () => {
    it("tells a repository apart from the account it belongs to", () => {
        expect(targetKey("acme", "web")).toBe("acme/web");
        expect(targetKey("acme", null)).toBe("acme");
    });
});

describe("servesLabels", () => {
    it("takes a job whose labels the pool carries", () => {
        expect(servesLabels(["self-hosted", "gpu"], ["self-hosted"])).toBe(true);
        expect(servesLabels(["self-hosted", "gpu"], ["self-hosted", "gpu"])).toBe(true);
    });

    it("leaves a job asking for something the pool does not have", () => {
        expect(servesLabels(["self-hosted"], ["self-hosted", "gpu"])).toBe(false);
    });

    it("ignores case and surrounding space, the way GitHub does", () => {
        expect(servesLabels(["self-hosted", "gpu"], [" Self-Hosted ", "GPU"])).toBe(true);
    });

    it("does not make a pool declare the labels GitHub adds by itself", () => {
        expect(servesLabels(["build"], ["self-hosted", "linux", "x64", "build"])).toBe(true);
    });

    it("takes a job that asked for nothing in particular", () => {
        expect(servesLabels(["self-hosted"], [])).toBe(true);
    });
});
