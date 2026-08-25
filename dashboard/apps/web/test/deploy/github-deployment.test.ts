/**
 * The two calls that put Polaris in a commit's deployment box.
 *
 * The body is the whole feature, and two of its fields are the reason it works
 * at all. Without `auto_merge: false` GitHub answers a ref behind its base branch
 * by merging into it - a deploy that quietly writes a commit into somebody's
 * repository, which is the worst thing a read-mostly integration could do. And
 * without an empty `required_contexts` it refuses outright whenever a check on
 * that commit has not passed, which for a push-triggered deploy is nearly always:
 * the build starts long before CI finishes. Both defaults are the wrong way round
 * for this, both are silent, and neither shows up until it happens to somebody.
 *
 * The rest guards what is announced rather than how: a commit rather than a
 * branch (a branch name would deploy whatever is at its head when somebody
 * clicks), an id only when GitHub actually minted one, and no "View deployment"
 * button pointing at a name that resolves nowhere.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDeployment, setDeploymentState } from "@/lib/github-service";
import { announceRefusal } from "@/lib/deploy/github-deployment";

const SHA = "9f2c1b0a4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f90";
const CALL = { owner: "acme", repo: "widgets", token: "gho_test" };

/** The bodies GitHub was sent, in order, parsed. */
let sent: Array<{ url: string; body: Record<string, unknown> }> = [];

/** GitHub answering with `status` and `payload` to whatever it is asked. */
function githubAnswers(status: number, payload: unknown): void {
    vi.stubGlobal("fetch", async (url: string, init: { body?: string }) => {
        sent.push({ url, body: JSON.parse(init.body ?? "{}") as Record<string, unknown> });
        return { status, ok: status < 300, json: async () => payload } as unknown as Response;
    });
}

beforeEach(() => {
    sent = [];
});

describe("minting the deployment", () => {
    it("asks GitHub not to merge anything and not to wait for checks", async () => {
        githubAnswers(201, { id: 4212 });
        await createDeployment({ ...CALL, ref: SHA, environment: "production/api", description: "x", production: true });

        expect(sent[0]?.url).toContain("/repos/acme/widgets/deployments");
        expect(sent[0]?.body.auto_merge).toBe(false);
        expect(sent[0]?.body.required_contexts).toEqual([]);
    });

    it("announces the commit rather than the branch, so it cannot drift", async () => {
        githubAnswers(201, { id: 4212 });
        await createDeployment({ ...CALL, ref: SHA, environment: "production/api", description: "x", production: true });

        expect(sent[0]?.body.ref).toBe(SHA);
    });

    it("hands back the id every later state is posted against", async () => {
        githubAnswers(201, { id: 4212 });
        const minted = await createDeployment({
            ...CALL,
            ref: SHA,
            environment: "production/api",
            description: "Deploying Acme / api on Polaris",
            production: true
        });
        expect(minted.id).toBe("4212");
    });

    it("has nothing to post against when GitHub refuses over a conflict", async () => {
        // 409 and 202 both answer with a message instead of a deployment. Reading
        // one as a deployment would leave every later state posting to a made-up id.
        githubAnswers(409, { message: "Conflict merging main into 9f2c1b0" });
        const minted = await createDeployment({ ...CALL, ref: SHA, environment: "production/api", description: "x", production: true });
        expect(minted.id).toBeNull();
        // Kept, because the sentence the deploy log gets is chosen by it.
        expect(minted.status).toBe(409);
    });

    it("keeps the first line of a description, cut to what GitHub shows", async () => {
        githubAnswers(201, { id: 1 });
        await createDeployment({
            ...CALL,
            ref: SHA,
            environment: "production/api",
            description: `${"deploy ".repeat(40)}\nand a second line nobody asked for`,
            production: false
        });

        const description = String(sent[0]?.body.description);
        expect(description.length).toBeLessThanOrEqual(140);
        expect(description).not.toContain("second line");
    });
});

describe("posting a state against it", () => {
    it("sends the state, and retires whatever was serving that environment", async () => {
        githubAnswers(201, {});
        await setDeploymentState({ ...CALL, deploymentId: "4212", state: "success", description: "Live" });

        expect(sent[0]?.url).toContain("/deployments/4212/statuses");
        expect(sent[0]?.body.state).toBe("success");
        expect(sent[0]?.body.auto_inactive).toBe(true);
    });

    it("offers no View deployment button when there is no address to offer", async () => {
        githubAnswers(201, {});
        await setDeploymentState({
            ...CALL,
            deploymentId: "4212",
            state: "success",
            description: "Live",
            environmentUrl: null,
            logUrl: null
        });

        expect(sent[0]?.body).not.toHaveProperty("environment_url");
        expect(sent[0]?.body).not.toHaveProperty("log_url");
    });

    it("carries the address when the release has a reachable one", async () => {
        githubAnswers(201, {});
        await setDeploymentState({
            ...CALL,
            deploymentId: "4212",
            state: "success",
            description: "Live",
            environmentUrl: "https://api.acme.example"
        });

        expect(sent[0]?.body.environment_url).toBe("https://api.acme.example");
    });

    it("reports a refusal rather than throwing into the deploy that called it", async () => {
        githubAnswers(403, { message: "Resource not accessible by integration" });
        const posted = await setDeploymentState({
            ...CALL,
            deploymentId: "4212",
            state: "failure",
            description: "The deploy failed"
        });
        expect(posted.status).toBe(403);
    });
});

/**
 * A refusal that only reached the server console was a refusal nobody here could
 * ever see: the deploy worked, the commit stayed empty, and the one screen its
 * operator opens said nothing about it. It is nearly always the same cause -
 * a token that can read a repository's contents cannot write its deployments -
 * and that is a permission to go and tick rather than a mystery.
 */
describe("what the deploy log is told when GitHub refuses", () => {
    it("names the permission behind a refusal, and where to add it", () => {
        const said = announceRefusal(403, "acme", "widgets");
        expect(said).toContain("Deployments: Read and write");
        expect(said).toContain("acme/widgets");
        expect(said).toContain("Connected accounts");
    });

    it("reads a repository it cannot see as the same thing to go and do", () => {
        expect(announceRefusal(404, "acme", "widgets")).toContain("Deployments: Read and write");
    });

    it("does not blame a permission for GitHub being unreachable", () => {
        const said = announceRefusal(0, "acme", "widgets");
        expect(said).toContain("could not be reached");
        expect(said).not.toContain("Deployments: Read and write");
    });

    it("says the status rather than guessing at anything else", () => {
        expect(announceRefusal(422, "acme", "widgets")).toContain("422");
    });
});
