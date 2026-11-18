/**
 * One data folder per stored account, for a tool whose vendor documents a
 * variable that moves its whole data folder but names no credential file in it
 * (`AgentCredential.dir`: Kimi Code, Pi, Autohand).
 *
 * Polaris cannot capture a file nobody named, so it captures nothing: the
 * sign-in runs with the variable pointed at a folder of the account's own, the
 * vendor's login lands there whatever it writes, and the stored row holds only
 * the folder's id. A session started on that account gets the variable pointed
 * at the same folder. Removing the row clears the folder.
 *
 * The folders sit in the person's own agent home, under the same
 * `.polaris-accounts` directory Codex's account homes use
 * (`account-homes.ts`): that home is the one directory both the sign-in
 * container and every session container of that person mount
 * (`commands.agentHomeSource`), and it is kept on the box between them. The id
 * is the sign-in attempt's row id, never anything typed, and is checked against
 * a strict shape before it becomes part of a path.
 *
 * Pure: the callers run the scripts.
 */

import * as core from "@polaris/core";
import { ACCOUNTS_DIR } from "./account-homes";

/** What a folder id may look like: a row id, and nothing that walks a path. */
const FOLDER_ID = /^[A-Za-z0-9_-]{1,64}$/;
const SAFE_HOME = /^\/[A-Za-z0-9._/-]+$/;
const CLI_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;

/** A credential kept in an account folder. */
export type FolderCredential = core.AgentCredential & { readonly dir: { readonly env: string; readonly path: string } };

function isFolderCredential(credential: core.AgentCredential): credential is FolderCredential {
    return Boolean(credential.dir);
}

/** The tool and credential a folder login's variable belongs to, or null. */
export function folderLoginFor(env: string): { cli: core.AgentCli; credential: FolderCredential } | null {
    for (const cli of core.AGENT_CLIS) {
        const credential = cli.credentials.find((entry) => entry.env === env);
        if (credential && isFolderCredential(credential)) return { cli, credential };
    }
    return null;
}

/** Whether a stored value can name a folder. */
export function isFolderId(id: string): boolean {
    return FOLDER_ID.test(id);
}

/** An account's folder, relative to the home. Throws on anything that is not one. */
export function accountFolderPath(cliId: string, id: string): string {
    if (!CLI_ID.test(cliId)) throw new Error("That is not a tool Polaris knows.");
    if (!isFolderId(id)) throw new Error("That is not an account Polaris stores.");
    return `${ACCOUNTS_DIR}/${cliId}/${id}`;
}

/** An account's folder, absolute. Throws on a home or id that is not one. */
export function accountFolder(userHome: string, cliId: string, id: string): string {
    if (!SAFE_HOME.test(userHome) || userHome.includes("..")) throw new Error("That is not a home Polaris can use.");
    return `${userHome}/${accountFolderPath(cliId, id)}`;
}

/**
 * A session's credentials with each folder login turned into the variable the
 * tool reads: the stored folder id becomes `dir.env`, pointed at that folder
 * inside `userHome`. Polaris's own name for the row never reaches the tool.
 *
 * `userHome` is null where the folder is not there to point at - a server's own
 * home, a shared workspace's home - and then the folder login is dropped, so
 * the tool answers with whatever login that machine has. A value that is not a
 * folder id is dropped the same way rather than becoming a path.
 */
export function withAccountFolders(
    cli: core.AgentCli,
    env: Record<string, string>,
    userHome: string | null
): Record<string, string> {
    const folders = cli.credentials.filter(isFolderCredential).filter((credential) => credential.env in env);
    if (folders.length === 0) return env;
    const out = { ...env };
    for (const credential of folders) {
        const id = out[credential.env] ?? "";
        delete out[credential.env];
        if (userHome && isFolderId(id)) out[credential.dir.env] = accountFolder(userHome, cli.id, id);
    }
    return out;
}

/** Every variable a folder login of this tool may set, so a refresh clears it. */
export function folderEnvs(cli: core.AgentCli): string[] {
    return cli.credentials.filter(isFolderCredential).map((credential) => credential.dir.env);
}

/**
 * The tool's first-run answers, moved into the account's folder.
 *
 * The answers (Polaris's hooks, mostly) are written relative to the home, at
 * the tool's default data folder; with the variable moved, the tool reads its
 * configuration from the account's folder instead, so that is where they go.
 * Answers elsewhere (the checkout, another folder) are left as they are.
 */
export function folderFirstRun(
    answers: readonly core.AgentFirstRunAnswer[],
    credential: FolderCredential,
    cliId: string,
    id: string
): core.AgentFirstRunAnswer[] {
    const folder = accountFolderPath(cliId, id);
    const prefix = `${credential.dir.path}/`;
    return answers.map((answer) =>
        answer.file.startsWith(prefix) ? { ...answer, file: `${folder}/${answer.file.slice(prefix.length)}` } : answer
    );
}

/**
 * The first-run answers a session runs with, given the credentials it was
 * handed (after `withAccountFolders`): moved into the folder the tool was
 * pointed at, or as they are when it was pointed at none.
 */
export function sessionFirstRun(
    cli: core.AgentCli,
    answers: readonly core.AgentFirstRunAnswer[],
    env: Record<string, string>,
    userHome: string
): readonly core.AgentFirstRunAnswer[] {
    const base = `${userHome}/${ACCOUNTS_DIR}/${cli.id}/`;
    for (const credential of cli.credentials.filter(isFolderCredential)) {
        const path = env[credential.dir.env];
        if (!path?.startsWith(base)) continue;
        const id = path.slice(base.length);
        if (isFolderId(id)) return folderFirstRun(answers, credential, cli.id, id);
    }
    return answers;
}

/** Prints the folder's id when the folder is there, nothing otherwise. Run as
 *  the agent, in the home the sign-in mounted. */
export function folderPresentCommand(cliId: string, id: string): string {
    const folder = accountFolderPath(cliId, id);
    return `[ -d "$HOME/${folder}" ] && printf %s ${id} || true`;
}

/** Removes an account's folder and everything the login left in it. */
export function clearFolderCommand(cliId: string, id: string): string {
    const folder = accountFolderPath(cliId, id);
    return `rm -rf -- "$HOME/${folder}"`;
}
