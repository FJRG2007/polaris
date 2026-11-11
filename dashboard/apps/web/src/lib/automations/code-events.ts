/**
 * Something on a connected GitHub repository, told to the automations
 * listening for it: a pull request opened, a review asked for, the app named
 * in a comment.
 *
 * Only to automations that run as the account that connected the repository,
 * and only while that account may still see agent work: the repository's
 * provider keys and usage ceilings are that account's, so nobody else's
 * automation can spend them.
 */

import * as core from "@polaris/core";
import { emitAppEvent } from "./app-events";
import type { AgentTrigger } from "@polaris/core";
import { sessionCan, type SessionUser } from "@/lib/session";

/** The event each repository trigger is sent as; `manual` is never one. */
const CODE_EVENT_OF = Object.fromEntries(
    Object.entries(core.CODE_EVENT_TRIGGERS).map(([name, trigger]) => [trigger, name])
) as Readonly<Record<Exclude<AgentTrigger, "manual">, core.CodeEventName>>;

export interface RepoHappening {
    readonly repo: { readonly id: string; readonly ownerId: string; readonly repoFullName: string };
    readonly trigger: Exclude<AgentTrigger, "manual">;
    readonly issueNumber: number | null;
    readonly prNumber: number | null;
    readonly title: string;
    readonly actor: string;
    readonly labels: readonly string[];
    readonly branch: string | null;
    readonly body: string;
}

/**
 * Send it; whether any automation took it. `delivery` is GitHub's id for the
 * webhook, so a delivery GitHub retries starts nothing twice; without one the
 * minute stands in for it.
 */
export async function announceRepoEvent(
    happening: RepoHappening,
    delivery: string | null
): Promise<boolean> {
    const number = happening.prNumber ?? happening.issueNumber;
    const name = CODE_EVENT_OF[happening.trigger];
    return emitAppEvent(
        name,
        {
            repoId: happening.repo.id,
            repo: happening.repo.repoFullName,
            number: number !== null && number > 0 ? number : null,
            pullRequest: happening.prNumber !== null,
            title: happening.title.slice(0, 500),
            actor: happening.actor.slice(0, 100),
            labels: happening.labels.slice(0, 50).map((label) => label.slice(0, 100)),
            branch: happening.branch?.slice(0, 255) ?? null,
            body: happening.body.slice(0, 4000)
        },
        {
            key: `${happening.repo.id}:${delivery ?? `${number}:${Math.floor(Date.now() / 60_000)}`}`,
            mayReceive: async (runner) => {
                if (runner.id !== happening.repo.ownerId) return false;
                const user: SessionUser = { ...runner, email: "", name: "", sessionId: "" };
                return sessionCan(user, "agents.read");
            }
        }
    );
}
