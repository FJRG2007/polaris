/**
 * What the repository picker reads, for whichever screen is asking.
 *
 * Both halves are the caller's own GitHub accounts rather than the instance's: a
 * repository list is personal, and a picker built on the operator's token would
 * show one person's private repositories to everybody holding the screen's
 * permission. The permission check itself stays in each app's action, because
 * Deploy, Agents and Runners each gate this on their own.
 */

import { z } from "zod";
import { parseGithubRepo } from "@/lib/repo-reference";
import { resolveGithubRepo, searchGithubRepos, type GithubRepo } from "@/lib/github-service";
import { githubCredentialsForUser, githubTokenForUser, listReposForUser } from "@/lib/github-access";

export interface PickerRepoList {
    connected: boolean;
    /** Named only when the person has linked exactly one account; two have no
     *  single login to show. */
    login: string | null;
    repos: GithubRepo[];
}

/** The repositories this person's linked accounts reach. A GitHub that will not
 *  answer is an empty list rather than an error: the picker still searches. */
export async function pickerRepoList(userId: string): Promise<PickerRepoList> {
    const accounts = await githubCredentialsForUser(userId);
    if (accounts.length === 0) return { connected: false, login: null, repos: [] };
    const login = accounts.length === 1 ? (accounts[0]?.login ?? null) : null;
    try {
        return { connected: true, login, repos: await listReposForUser(userId) };
    } catch {
        return { connected: true, login, repos: [] };
    }
}

const repoQuerySchema = z.string().trim().min(2).max(200);

/**
 * Repositories matching what was typed, beyond the account's own list: the exact
 * repository when the input names one (a pasted URL, an SSH remote,
 * `owner/repo`), and GitHub's public search otherwise.
 *
 * Called as the operator types, so a query GitHub will not answer - too short,
 * rate limited, no such repository - is an empty list rather than an error; the
 * field keeps showing whatever the local list already matched.
 */
export async function pickerRepoSearch(userId: string, query: unknown): Promise<GithubRepo[]> {
    const parsed = repoQuerySchema.safeParse(query);
    if (!parsed.success) return [];
    try {
        const reference = parseGithubRepo(parsed.data);
        if (reference) {
            const token = await githubTokenForUser(userId, reference.owner);
            const repo = await resolveGithubRepo(reference.owner, reference.repo, token);
            if (repo) return [repo];
        }
        return await searchGithubRepos(parsed.data, await githubTokenForUser(userId));
    } catch {
        return [];
    }
}
