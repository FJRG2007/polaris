/**
 * Which fold a finished step of Polar's chat belongs to, so consecutive steps
 * of one kind read as one line ("Searched the web 3 times", "Read 2 files")
 * the way Polar Code's thread folds them (`code-steps.ts`). A web search, a
 * page read and a repository read, list or search fold by the shared verb;
 * a browser action folds with the same action; any other tool with itself. A
 * command run on a server never folds. Pure and client-safe.
 */

import { browserStepOf } from "@/lib/polar/browser-steps";
import { repoStepOf } from "@/lib/polar/code-host";
import { webStepOf } from "@/lib/polar/web-sources";
import * as serverCommand from "@/lib/polar/server-command";

export function chatStepGroup(name: string, input: unknown): string | null {
    if (serverCommand.serverCommandOf(name, input)) return null;
    const repo = repoStepOf(name, input);
    if (repo) return repo.kind === "read" ? "read" : repo.kind === "search" ? "grep" : repo.kind === "list" ? "list" : `repo:${repo.kind}`;
    const browser = browserStepOf(name, input);
    if (browser) return `browser:${browser.kind}`;
    const web = webStepOf(name, input);
    if (web) return web.kind === "search" ? "webSearch" : "webFetch";
    return `tool:${name}`;
}
