/**
 * The reviewer agent: a head is reviewed once, a failed automatic pass is
 * retried up to a bound, the container gets nothing that can push and no line
 * break in its environment, the result is read back bounded and only from a
 * block that parses, and requested changes reach the session once, under its
 * feedback switch. The container engine is mocked throughout.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("@polaris/db", () => ({ prisma: {} }));

import * as core from "@polaris/core";
import * as reviewer from "@/lib/agents/session-reviewer";
import { requestReview, sweepReviews, type ReviewerDeps } from "@/lib/agents/session-reviewer-service";

const SHA = "a".repeat(40);
const claude = reviewer.reviewerCli("claude")!;

const open = { state: "open", draft: false, headSha: SHA };
const run = (over: Partial<reviewer.PlanRun> = {}): reviewer.PlanRun => ({
    headSha: SHA,
    attempt: 1,
    state: "complete",
    verdict: null,
    trigger: "auto",
    ...over
});

describe("planReview", () => {
    it("starts the first pass on a new head", () => {
        expect(reviewer.planReview(open, [], "auto")).toEqual({ start: true, attempt: 1 });
        expect(reviewer.planReview(open, [run({ headSha: "b".repeat(40), verdict: "approved" })], "auto")).toEqual({
            start: true,
            attempt: 1
        });
    });

    it("does not review the same head again", () => {
        expect(reviewer.planReview(open, [run({ verdict: "approved" })], "auto")).toEqual({
            start: false,
            reason: "already_approved"
        });
        expect(reviewer.planReview(open, [run({ verdict: "changes_requested" })], "auto")).toMatchObject({
            reason: "changes_requested_same_sha"
        });
        expect(reviewer.planReview(open, [run({ state: "running" })], "auto")).toMatchObject({ reason: "review_running" });
        expect(reviewer.planReview(open, [run({ state: "cancelled" })], "auto")).toMatchObject({
            reason: "cancelled_same_sha"
        });
    });

    it("retries a failed automatic pass up to the bound", () => {
        const failed = (attempt: number) => run({ state: "failed", attempt });
        expect(reviewer.planReview(open, [failed(1), failed(2)], "auto")).toEqual({ start: true, attempt: 3 });
        expect(reviewer.planReview(open, [failed(1), failed(2), failed(3)], "auto")).toMatchObject({
            reason: "failed_same_sha_retry_limit"
        });
    });

    it("skips drafts, closed and merged pull requests", () => {
        expect(reviewer.planReview({ ...open, draft: true }, [], "auto")).toMatchObject({ reason: "draft_pr" });
        expect(reviewer.planReview({ ...open, state: "closed" }, [], "auto")).toMatchObject({ reason: "closed_pr" });
        expect(reviewer.planReview({ ...open, state: "merged" }, [], "auto")).toMatchObject({ reason: "merged_pr" });
        expect(reviewer.planReview({ ...open, headSha: "" }, [], "auto")).toMatchObject({ reason: "missing_head_sha" });
    });

    it("lets a person ask again unless one is running", () => {
        expect(reviewer.planReview(open, [run({ verdict: "approved" })], "manual")).toEqual({ start: true, attempt: 2 });
        expect(reviewer.planReview(open, [run({ state: "running" })], "manual")).toMatchObject({ start: false });
    });
});

describe("parseReviewOutput", () => {
    const block = (body: unknown) => `${reviewer.BEGIN}\n${JSON.stringify(body)}\n${reviewer.END}`;

    it("reads the last block that parses, skipping an echoed template", () => {
        const output = [
            reviewer.reviewerPrompt({ repoFullName: "o/r", number: 1, headSha: SHA, baseBranch: "main" }),
            "thinking...",
            block({ verdict: "changes_requested", summary: "One bug.", findings: [{ path: "a.ts", line: 3, body: "Null check." }] })
        ].join("\n");
        expect(reviewer.parseReviewOutput(output)).toEqual({
            verdict: "changes_requested",
            summary: "One bug.",
            findings: [{ path: "a.ts", line: 3, body: "Null check." }]
        });
    });

    it("is null without a block, and drops malformed findings", () => {
        expect(reviewer.parseReviewOutput("no result here")).toBeNull();
        expect(reviewer.parseReviewOutput(block({ verdict: "maybe" }))).toBeNull();
        const parsed = reviewer.parseReviewOutput(
            block({ verdict: "changes_requested", findings: [{ path: "", body: "x" }, { nope: 1 }] })
        );
        // Changes asked with nothing to act on read as approved.
        expect(parsed).toEqual({ verdict: "approved", summary: "", findings: [] });
    });

    it("bounds the summary and the findings", () => {
        const findings = Array.from({ length: reviewer.FINDINGS_MAX + 10 }, (_, i) => ({
            path: `f${i}.ts`,
            line: i + 1,
            body: "y".repeat(reviewer.FINDING_MAX + 5)
        }));
        const parsed = reviewer.parseReviewOutput(
            block({ verdict: "changes_requested", summary: "s".repeat(reviewer.SUMMARY_MAX + 100), findings })
        )!;
        expect(parsed.summary).toHaveLength(reviewer.SUMMARY_MAX);
        expect(parsed.findings).toHaveLength(reviewer.FINDINGS_MAX);
        expect(parsed.findings[0]!.body).toHaveLength(reviewer.FINDING_MAX);
    });
});

describe("the container", () => {
    const input = {
        repoFullName: "acme/app",
        number: 4,
        headSha: SHA,
        baseBranch: "main",
        cli: claude,
        model: "claude-opus-4",
        auth: "Authorization: Basic eA==",
        credentials: { ANTHROPIC_API_KEY: "k" }
    };

    it("carries no push credential and no line break", () => {
        const env = reviewer.reviewerEnv(input, { user: "node", home: "/home/node" });
        for (const value of Object.values(env)) expect(core.hasControlCharacter(value)).toBe(false);
        expect(env).not.toHaveProperty("GH_TOKEN");
        expect(env).not.toHaveProperty("GITHUB_TOKEN");
        expect(Object.keys(env).some((key) => key.startsWith("POLARIS_SESSION"))).toBe(false);
        const run = Buffer.from(env.POLARIS_REVIEW_RUN!, "base64").toString("utf8");
        expect(run).toContain("'-p'");
        // The model goes where the catalogue says the tool reads it.
        if (claude.model?.flag) expect(run).toContain("claude-opus-4");
        else if (claude.model?.env) expect(env[claude.model.env]).toBe("claude-opus-4");
    });

    it("drops the clone credential before the tool and turns hooks off", () => {
        const script = reviewer.reviewerScript(": setup");
        const unset = script.indexOf("unset POLARIS_REVIEW_AUTH");
        expect(unset).toBeGreaterThan(script.indexOf("fetch"));
        expect(unset).toBeLessThan(script.indexOf("as_agent"));
        expect(script).toContain("core.hooksPath /dev/null");
        expect(script).not.toContain("credential.helper");
    });

    it("refuses values that could reach a shell or a ref", () => {
        const home = { user: "node", home: "/home/node" };
        expect(() => reviewer.reviewerEnv({ ...input, headSha: "HEAD" }, home)).toThrow();
        expect(() => reviewer.reviewerEnv({ ...input, baseBranch: "main;rm -rf /" }, home)).toThrow();
        expect(() => reviewer.reviewerEnv({ ...input, repoFullName: "../x" }, home)).toThrow();
        expect(() => reviewer.reviewerEnv({ ...input, credentials: { K: "a\nb" } }, home)).toThrow(/K/);
        const unsafe = reviewer.reviewerCommand(claude, "x; rm -rf /");
        expect(unsafe.line).not.toContain("rm -rf");
    });

    it("only offers tools with a headless mode", () => {
        expect(reviewer.reviewerClis().length).toBeGreaterThan(0);
        for (const cli of reviewer.reviewerClis()) expect(cli.headless?.length).toBeGreaterThan(0);
    });
});

function deps(over: Partial<ReviewerDeps> = {}): ReviewerDeps & { calls: Record<string, unknown[][]> } {
    const calls: Record<string, unknown[][]> = {};
    const track =
        <A extends unknown[], R>(name: string, value: (...args: A) => R) =>
        (...args: A) => {
            (calls[name] ??= []).push(args);
            return value(...args);
        };
    const base: ReviewerDeps = {
        now: () => 1_000_000_000,
        session: track("session", async () => ({
            state: "running",
            ownerId: "u1",
            hostId: null,
            sharedHome: false,
            autoFeedback: true,
            repoFullName: "acme/app",
            reviewer: { cli: "claude", model: null }
        })),
        pull: track("pull", async () => ({ state: "open", draft: false, headSha: SHA, targetBranch: "main" })),
        runs: track("runs", async () => []),
        create: track("create", async () => "rev-1"),
        cloneAuth: track("cloneAuth", async () => "Authorization: Basic eA=="),
        credentials: track("credentials", async () => ({})),
        start: track("start", async () => undefined),
        containerState: track("containerState", async () => "stopped" as const),
        logs: track("logs", async () => ""),
        remove: track("remove", async () => undefined),
        finish: track("finish", async () => true),
        running: track("running", async () => []),
        words: track("words", async () => (key: string, values?: Record<string, string | number>) =>
            `${key}${values ? JSON.stringify(values) : ""}`),
        enqueue: track("enqueue", async () => true),
        markFedBack: track("markFedBack", async () => undefined),
        deliver: track("deliver", async () => undefined)
    };
    return Object.assign({ ...base, ...over }, { calls });
}

describe("requestReview", () => {
    it("opens a row and starts its container on the session's machine", async () => {
        const d = deps();
        expect(await requestReview({ sessionId: "s1", number: 4, trigger: "auto" }, d)).toEqual({
            started: true,
            reviewId: "rev-1"
        });
        expect(d.calls.create![0]![0]).toMatchObject({ headSha: SHA, attempt: 1, cli: "claude", trigger: "auto" });
        const [target, name, env] = d.calls.start![0]! as [unknown, string, Record<string, string>];
        expect(target).toEqual({ hostId: null, ownerId: "u1", sharedHome: false });
        expect(name).toBe(reviewer.reviewContainerName("rev-1"));
        expect(env.POLARIS_REVIEW_SHA).toBe(SHA);
    });

    it("starts nothing without a reviewer, for an ended session, or twice for one head", async () => {
        const none = deps({
            session: async () => ({
                state: "running",
                ownerId: "u1",
                hostId: null,
                sharedHome: false,
                autoFeedback: true,
                repoFullName: "acme/app",
                reviewer: null
            })
        });
        expect(await requestReview({ sessionId: "s1", number: 4, trigger: "auto" }, none)).toEqual({
            started: false,
            reason: "missing_reviewer"
        });
        const raced = deps({ create: async () => null });
        expect(await requestReview({ sessionId: "s1", number: 4, trigger: "auto" }, raced)).toMatchObject({
            reason: "review_running"
        });
        expect(raced.calls.start).toBeUndefined();
        const approved = deps({ runs: async () => [run({ verdict: "approved" })] });
        expect(await requestReview({ sessionId: "s1", number: 4, trigger: "auto" }, approved)).toMatchObject({
            reason: "already_approved"
        });
    });

    it("records a start that failed instead of throwing", async () => {
        const d = deps({
            start: async () => {
                throw new Error("daemon refused");
            }
        });
        const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
        expect(await requestReview({ sessionId: "s1", number: 4, trigger: "auto" }, d)).toEqual({
            started: false,
            reason: "start_failed"
        });
        errors.mockRestore();
        expect(d.calls.finish![0]).toEqual(["rev-1", { state: "failed", error: "start_failed" }]);
    });
});

describe("sweepReviews", () => {
    const row = { id: "rev-1", sessionId: "s1", number: 4, hostId: null, startedAt: new Date(1_000_000_000 - 60_000) };
    const output = `${reviewer.BEGIN}\n${JSON.stringify({
        verdict: "changes_requested",
        summary: "Fix it.",
        findings: [{ path: "a.ts", line: 2, body: "Handle null." }]
    })}\n${reviewer.END}`;

    it("stores the result, removes the container and queues the changes once", async () => {
        const d = deps({ running: async () => [row], logs: async () => output });
        const base = d.session;
        d.session = async (id) => ({ ...(await base(id))!, state: "idle" });
        expect(await sweepReviews(d)).toBe(1);
        expect(d.calls.finish![0]![1]).toMatchObject({ state: "complete", verdict: "changes_requested" });
        expect(d.calls.remove).toHaveLength(1);
        const [, owner, key, text] = d.calls.enqueue![0]! as string[];
        expect(owner).toBe("u1");
        expect(key).toBe("reviewer:4");
        expect(text).toContain("a.ts:2");
        expect(d.calls.markFedBack).toEqual([["rev-1"]]);
        expect(d.calls.deliver).toEqual([["s1"]]);
    });

    it("does not queue twice when another sweep closed the row first", async () => {
        const d = deps({ running: async () => [row], logs: async () => output, finish: async () => false });
        expect(await sweepReviews(d)).toBe(0);
        expect(d.calls.enqueue).toBeUndefined();
    });

    it("respects the session's feedback switch", async () => {
        const d = deps({
            running: async () => [row],
            logs: async () => output,
            session: async () => ({
                state: "running",
                ownerId: "u1",
                hostId: null,
                sharedHome: false,
                autoFeedback: false,
                repoFullName: "acme/app",
                reviewer: { cli: "claude", model: null }
            })
        });
        await sweepReviews(d);
        expect(d.calls.enqueue).toBeUndefined();
    });

    it("leaves a running pass alone, and fails one past its timeout", async () => {
        const live = deps({ running: async () => [row], containerState: async () => "running" });
        expect(await sweepReviews(live)).toBe(0);
        expect(live.calls.finish).toBeUndefined();
        const old = { ...row, startedAt: new Date(1_000_000_000 - reviewer.REVIEW_TIMEOUT_MS - 1) };
        const stuck = deps({ running: async () => [old], containerState: async () => "running" });
        await sweepReviews(stuck);
        expect(stuck.calls.remove).toHaveLength(1);
        expect(stuck.calls.finish![0]![1]).toMatchObject({ state: "failed", error: "timed_out" });
    });

    it("gives a container that has not appeared a grace period", async () => {
        const fresh = deps({ running: async () => [row], containerState: async () => "gone" });
        await sweepReviews(fresh);
        expect(fresh.calls.finish).toBeUndefined();
        const old = { ...row, startedAt: new Date(1_000_000_000 - reviewer.START_GRACE_MS - 1) };
        const lost = deps({ running: async () => [old], containerState: async () => "gone" });
        await sweepReviews(lost);
        expect(lost.calls.finish![0]![1]).toMatchObject({ state: "failed", error: "container_gone" });
    });

    it("fails a pass that printed no result, without feedback", async () => {
        const d = deps({ running: async () => [row], logs: async () => "crashed" });
        await sweepReviews(d);
        expect(d.calls.finish![0]![1]).toMatchObject({ state: "failed", error: "no_result" });
        expect(d.calls.enqueue).toBeUndefined();
    });
});
