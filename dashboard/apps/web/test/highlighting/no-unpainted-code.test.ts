/**
 * Code shown anywhere is painted by the shared highlighter - `CodeView`,
 * `JsonView`, `CodeLine` (components/json-view.tsx) or `CodeSurface`. The
 * Analytics tracking tag went out as a plain `<pre>` and a read-only input, and
 * the operator had to point it out.
 *
 * A `<pre>` is how a block of code usually slips in, so every file that writes
 * one is named below with what it holds. Logs, a terminal's screen and plain
 * text have no grammar and stay plain; a new `<pre>` has to be added here with
 * its reason, which is the moment to ask whether it is code. A read-only input
 * or a scrolling `<code>` holding a snippet is the other way in, and fails too.
 */

import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { join, relative, sep } from "node:path";
import { readdirSync, readFileSync } from "node:fs";

const ROOT = fileURLToPath(new URL("../../../../", import.meta.url));

/** Files that write a `<pre>`, each with what it holds. */
const PLAIN_PRE: Record<string, string> = {
    "apps/extension/src/entrypoints/sidepanel/offline.tsx": "offline reply text; the extension ships no highlighter",
    "apps/translate/src/screens/website-mode.tsx": "a translated web page's own <pre> content",
    "apps/web/src/app/(app)/apps/agents/runs/runs-view.tsx": "a failed gate step's log",
    "apps/web/src/app/(app)/apps/containers/[containerId]/container-view.tsx": "container logs",
    "apps/web/src/app/(app)/apps/databases/workbench.tsx": "a stored value that is not JSON",
    "apps/web/src/app/(app)/apps/deploy/cron-panel.tsx": "a cron run's output",
    "apps/web/src/app/(app)/apps/deploy/settings/automations-section.tsx": "a step's output",
    "apps/web/src/app/(app)/apps/firewall/condition-builder.tsx": "a firewall expression; no grammar exists for it",
    "apps/web/src/app/(app)/apps/firewall/managed-rule-page.tsx": "a firewall expression; no grammar exists for it",
    "apps/web/src/app/(app)/apps/servers/edge-panel.tsx": "an edge repair log",
    "apps/web/src/app/(app)/drive/viewer/text-editor.tsx": "a plain text file with find marks",
    "apps/web/src/app/(app)/mail-server/[id]/overview-tab.tsx": "a setup log",
    "apps/web/src/app/(app)/telemetry/event-detail.tsx": "stack frames painted per line by the highlighter, and a non-JSON body",
    "apps/web/src/app/vs/[id]/send-reader.tsx": "a shared plain text",
    "apps/web/src/components/code-surface.tsx": "the highlighter itself",
    "apps/web/src/components/json-view.tsx": "the highlighter itself",
    "apps/web/src/components/model-keys/signin-dialog.tsx": "a terminal screen",
    "apps/web/src/components/polar/elements/tool.tsx": "a tool result that is not JSON",
    "apps/web/src/components/rich-text/code-block.tsx": "a code block painted by the highlighter",
    "apps/web/src/components/rich-text/editor-code-block.tsx": "a code block painted by the highlighter",
    "apps/web/src/components/rich-text/rich-text.tsx": "the rich-text renderer's code node"
};

/** Files with a scrolling `<code>` that is not a snippet, each with what it holds. */
const PLAIN_CODE: Record<string, string> = {
    "apps/site/src/components/install-command.tsx": "the unpainted fallback of a line painted at build time",
    "apps/web/src/app/(app)/account/assistants/connect-guides.tsx": "a name, an address or a transport; commands and configs use CodeView"
};

function sources(dir: string): string[] {
    const found: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
        const path = join(dir, entry.name);
        if (entry.isDirectory()) found.push(...sources(path));
        else if (entry.name.endsWith(".tsx")) found.push(path);
    }
    return found;
}

const files = readdirSync(join(ROOT, "apps"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => {
        try {
            return sources(join(ROOT, "apps", entry.name, "src"));
        } catch {
            return [];
        }
    })
    .map((path) => ({ name: relative(ROOT, path).split(sep).join("/"), text: readFileSync(path, "utf8") }));

describe("code is painted wherever it is shown", () => {
    it("found the dashboard's sources", () => {
        expect(files.length).toBeGreaterThan(500);
    });

    it("writes a <pre> only where the block is not code", () => {
        const unexplained = files
            .filter((file) => /<pre\b/.test(file.text) && !(file.name in PLAIN_PRE))
            .map((file) => file.name);
        expect(unexplained).toEqual([]);
    });

    it("keeps no stale entry on that list", () => {
        const names = new Set(files.filter((file) => /<pre\b/.test(file.text)).map((file) => file.name));
        expect(Object.keys(PLAIN_PRE).filter((name) => !names.has(name))).toEqual([]);
    });

    it("never shows a snippet in a read-only input or a scrolling <code>", () => {
        const offending = files.flatMap((file) => {
            const found: string[] = [];
            if (/<Input(?=[^>]*readOnly)[^>]*value=\{\s*(snippet|code|command|tag)/s.test(file.text)) {
                found.push(`${file.name}: read-only input`);
            }
            if (
                !(file.name in PLAIN_CODE) &&
                /<code[^>]*className="[^"]*(whitespace-pre|overflow-x-auto)/.test(file.text)
            ) {
                found.push(`${file.name}: scrolling <code>`);
            }
            return found;
        });
        expect(offending).toEqual([]);
    });
});
