/**
 * An interactive session opened by something that happened on GitHub.
 *
 * An automation whose target is `session` opens a session rather than a
 * headless run: the same agent CLI, in its own container, that somebody can
 * watch, answer and steer. The issue is told where to watch it, and told again
 * when the session's pull request opens.
 *
 * The session spends the repository owner's account: an automation is the
 * owner's standing instruction, and the person who opened the issue is a
 * stranger as far as credentials go. The issue text reaches the agent fenced,
 * the way `describe()` fences it for a run.
 */

import { after } from "next/server";
import * as core from "@polaris/core";
import * as runtime from "./session-runtime";
import * as sessions from "./session-service";
import * as github from "@/lib/github-service";
import { appBaseUrl } from "@/lib/domain-service";
import { agentChoicesFor } from "./agent-readiness";
import { checkUsageLimits } from "./agent-usage-limits";
import { wordsFor } from "@/lib/notifications/notice-words";
import { capacityRefusal, sessionCapacity } from "./session-capacity";

/** Which agent an automation's session runs: Claude when it is signed in, else
 *  the first catalogued agent that is, else null - nothing to start. Pure. */
export function pickSessionAgent(
    choices: readonly { id: string; readiness: core.AgentReadiness }[]
): string | null {
    const ready = choices.filter((choice) => choice.readiness !== "missing");
    return (ready.find((choice) => choice.id === "claude") ?? ready[0])?.id ?? null;
}

/** The prompt a session from an issue opens with: the operator's instructions,
 *  then what happened. Pure. */
export function issueSessionPrompt(instructions: string, described: string): string {
    const said = instructions.trim();
    return [said, described].filter(Boolean).join("\n\n");
}

export interface IssueSessionInput {
    repo: { id: string; ownerId: string; repoFullName: string };
    issueNumber: number | null;
    prNumber: number | null;
    title: string;
    instructions: string;
    described: string;
}

/**
 * Open the session, hand it the issue, and post its link on the issue.
 *
 * Returns the session's id, or null when it could not be opened: no agent is
 * signed in, the owner is at their session ceiling or a usage limit. Those are
 * the owner's to see, so the refusal is said on the issue rather than lost.
 */
export async function startIssueSession(input: IssueSessionInput): Promise<string | null> {
    const { repo } = input;
    const [owner, name] = repo.repoFullName.split("/") as [string, string];
    const number = input.issueNumber ?? input.prNumber;
    const t = await wordsFor(repo.ownerId, "agents");
    const token = await github.githubAppInstallationToken(owner).catch(() => null);
    const say = async (body: string) => {
        if (token && number !== null)
            await github.commentOnIssue(owner, name, number, body, token).catch(() => false);
    };

    const cli = pickSessionAgent(await agentChoicesFor(repo.ownerId));
    if (!cli) {
        await say(t("issueSessions.noAgent"));
        return null;
    }
    const refusal = capacityRefusal(await sessionCapacity(repo.ownerId));
    const limits = refusal
        ? null
        : await checkUsageLimits({
              ownerId: repo.ownerId,
              repoFullName: repo.repoFullName,
              kind: "session"
          });
    if (refusal || (limits && !limits.allowed)) {
        await say(t("issueSessions.refused"));
        return null;
    }

    const { session, token: reportToken } = await sessions.createSession({
        repoId: repo.id,
        startedById: repo.ownerId,
        title: input.title.slice(0, 200) || repo.repoFullName,
        cli,
        command: null,
        place: "local",
        sharedHome: false,
        unattended: null,
        accountId: null,
        useMachineLogin: false,
        hostId: null,
        baseRef: "",
        taskId: null,
        enigma: null,
        issueNumber: number
    });
    try {
        await runtime.startSession(session, reportToken);
    } catch (error) {
        sessions.readableFailure(error, `starting ${session.id} for an issue`);
        await say(t("issueSessions.failed"));
        return session.id;
    }
    const prompt = issueSessionPrompt(input.instructions, input.described);
    await sessions.addSessionMessage(session.id, "user", prompt, repo.ownerId);
    after(() => runtime.deliverFirstPrompt(session.id, prompt));

    const base = (await appBaseUrl()).replace(/\/+$/, "");
    await say(
        t("issueSessions.started", {
            url: `${base}/polar?session=${session.id}`,
            branch: session.branch
        })
    );
    return session.id;
}

/**
 * Tell the issue a session was opened for that its pull request is up.
 * Best effort: the pull request exists whether or not the note lands.
 */
export async function noteIssueOfPull(
    session: Pick<sessions.SessionView, "issueNumber" | "repoFullName" | "ownerId">,
    pull: { number: number; url: string }
): Promise<void> {
    if (session.issueNumber === null || !session.repoFullName || !session.ownerId) return;
    if (session.issueNumber === pull.number) return;
    const [owner, name] = session.repoFullName.split("/") as [string, string];
    const token = await github.githubAppInstallationToken(owner).catch(() => null);
    if (!token) return;
    const t = await wordsFor(session.ownerId, "agents");
    await github
        .commentOnIssue(
            owner,
            name,
            session.issueNumber,
            t("issueSessions.pullOpened", { number: pull.number, url: pull.url }),
            token
        )
        .catch(() => false);
}
