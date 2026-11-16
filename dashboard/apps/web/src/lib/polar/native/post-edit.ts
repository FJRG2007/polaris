/**
 * What happens after Write or Edit saves a file: the project's formatter runs
 * on it (`format.ts`) and a language server's errors for it (`lsp.ts`) are
 * appended to the tool result, as OpenCode's edit tool does. One set of
 * formatter lookups and language servers per workspace, so a session and its
 * subagents share them.
 *
 * Never fails the edit: anything that goes wrong is logged and left out of
 * the result. Server-free.
 */

import { LspPool } from "@/lib/polar/native/lsp";
import type { SessionState } from "@/lib/polar/native/tools";
import type { Workspace } from "@/lib/polar/native/workspace";
import { formatFile, type Log } from "@/lib/polar/native/format";

export interface EditTooling {
    readonly formatCache: Map<string, string[] | null>;
    readonly lsp: LspPool;
    readonly log: Log;
}

const toolings = new WeakMap<Workspace, EditTooling>();

const stderrLog: Log = (line) => {
    try {
        process.stderr.write(`polaris-agent: ${line}\n`);
    } catch {
        // Nowhere to say it.
    }
};

/** The workspace's tooling; `log` only matters the first time it is asked for. */
export function editTooling(ws: Workspace, log: Log = stderrLog): EditTooling {
    let tooling = toolings.get(ws);
    if (!tooling) {
        tooling = { formatCache: new Map(), lsp: new LspPool(ws, log), log };
        toolings.set(ws, tooling);
    }
    return tooling;
}

/** Formats and checks `file`, and answers the text to add to the tool's own
 *  result ("" for nothing). Keeps the session's read record current, so the
 *  next Edit does not take the formatter's change for someone else's. */
export async function afterWrite(context: { ws: Workspace; state: SessionState; signal?: AbortSignal }, file: string): Promise<string> {
    const { ws, state, signal } = context;
    const notes: string[] = [];
    try {
        const tooling = editTooling(ws);
        const before = await ws.readFile(file).catch(() => null);
        const formatted = await formatFile(ws, file, { signal, log: tooling.log, cache: tooling.formatCache });
        if (formatted.ran.length > 0) {
            const after = await ws.readFile(file).catch(() => null);
            const stat = await ws.stat(file);
            if (stat) state.read.set(file, stat.mtimeMs);
            if (before && after && !before.equals(after)) {
                notes.push(`Formatted with ${formatted.ran.join(", ")}; Read the file again before editing the changed lines.`);
            }
        }
        const diagnostics = await tooling.lsp.diagnose(file, signal);
        if (diagnostics) notes.push(diagnostics);
    } catch (error) {
        stderrLog(`after-edit checks skipped for ${file}: ${(error as Error).message}`);
    }
    return notes.length > 0 ? `\n\n${notes.join("\n\n")}` : "";
}
