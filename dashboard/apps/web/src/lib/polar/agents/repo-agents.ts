/**
 * Agent files read from a connected repository on GitHub (`AGENT_FILE_DIRS`),
 * for the settings import and for a Code session, which hands the
 * repository's `.polaris/agents` to the coding tools in the formats they read.
 *
 * Bounded everywhere: a few folders, at most `REPO_AGENT_FILES_MAX` files of at
 * most `AGENT_FILE_MAX` each, and one deadline for the whole read. Never
 * throws: a repository GitHub will not list reads as having no agents.
 *
 * Server-only.
 */

import { z } from "zod";
import {
    AGENT_FILE_DIRS,
    AGENT_FILE_MAX,
    parseAgentFile,
    type AgentFile
} from "@/lib/polar/agents/agent-files";

const API = "https://api.github.com";
/** Files read from one repository, across every folder. */
export const REPO_AGENT_FILES_MAX = 20;
/** How long GitHub gets for the whole read. */
const READ_TIMEOUT_MS = 8_000;
/** The most the session's agent files may take once encoded, so the boot
 *  environment stays well inside what a container accepts. */
export const SESSION_AGENT_FILES_BYTES = 96 * 1024;

export interface RepoAgentFile {
    readonly path: string;
    readonly content: string;
}

const listingSchema = z.array(
    z.object({
        type: z.string(),
        name: z.string(),
        path: z.string(),
        size: z.number().int().nonnegative()
    })
);

function headers(token: string | null, raw: boolean): HeadersInit {
    return {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        Accept: raw ? "application/vnd.github.raw+json" : "application/vnd.github+json",
        "User-Agent": "polaris",
        "X-GitHub-Api-Version": "2022-11-28"
    };
}

function contentsUrl(owner: string, name: string, path: string, ref: string | null): string {
    const encoded = path.split("/").map(encodeURIComponent).join("/");
    const query = ref ? `?ref=${encodeURIComponent(ref)}` : "";
    return `${API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/contents/${encoded}${query}`;
}

/**
 * The agent files of one repository at `ref` (null is the default branch),
 * from `dirs` in that order, Markdown files only.
 */
export async function repoAgentFiles(
    repo: { owner: string; name: string; token: string | null },
    ref: string | null,
    dirs: readonly string[] = AGENT_FILE_DIRS
): Promise<RepoAgentFile[]> {
    const signal = AbortSignal.timeout(READ_TIMEOUT_MS);
    const listed = await Promise.all(
        dirs.map(async (dir) => {
            try {
                const response = await fetch(contentsUrl(repo.owner, repo.name, dir, ref), {
                    headers: headers(repo.token, false),
                    cache: "no-store",
                    signal
                });
                if (!response.ok) return [];
                const parsed = listingSchema.safeParse(await response.json());
                if (!parsed.success) return [];
                return parsed.data
                    .filter(
                        (entry) =>
                            entry.type === "file" &&
                            /\.md$/i.test(entry.name) &&
                            entry.size <= AGENT_FILE_MAX
                    )
                    .sort((a, b) => a.name.localeCompare(b.name))
                    .map((entry) => entry.path);
            } catch {
                return [];
            }
        })
    );
    const paths = listed.flat().slice(0, REPO_AGENT_FILES_MAX);
    const read = await Promise.all(
        paths.map(async (path): Promise<RepoAgentFile | null> => {
            try {
                const response = await fetch(contentsUrl(repo.owner, repo.name, path, ref), {
                    headers: headers(repo.token, true),
                    cache: "no-store",
                    signal
                });
                if (!response.ok) return null;
                const content = await response.text();
                return content.length > AGENT_FILE_MAX ? null : { path, content };
            } catch {
                return null;
            }
        })
    );
    return read.filter((file): file is RepoAgentFile => file !== null);
}

/** A file name safe on any machine, from the agent's name. */
function fileBase(name: string): string {
    return (
        name
            .toLowerCase()
            .replace(/[^a-z0-9._-]+/g, "-")
            .replace(/^[-.]+|-+$/g, "")
            .slice(0, 64) || "agent"
    );
}

/** One agent as a Claude Code subagent file: `name` and `description` are
 *  the fields it requires; the body is the prompt. */
export function claudeAgentFile(agent: AgentFile): string {
    const description = (agent.description || agent.name).replace(/\s+/g, " ");
    return [
        "---",
        `name: ${JSON.stringify(fileBase(agent.name))}`,
        `description: ${JSON.stringify(description)}`,
        "---",
        "",
        agent.instructions,
        ""
    ].join("\n");
}

/**
 * The repository's `.polaris/agents` as the files the coding tools read in a
 * checkout: OpenCode's `.opencode/agent/` takes the file as written (it is
 * OpenCode's format), Claude Code's `.claude/agents/` a file in its own. A
 * subagent-only agent of OpenCode's goes to both; a primary-only one is not a
 * Claude subagent and stays out of `.claude/agents`. Bounded by
 * `SESSION_AGENT_FILES_BYTES`; what does not fit is left out.
 */
export function sessionAgentFiles(files: readonly RepoAgentFile[]): Record<string, string> {
    const out: Record<string, string> = {};
    let bytes = 2;
    const put = (path: string, content: string): boolean => {
        const cost = Buffer.byteLength(JSON.stringify(path) + JSON.stringify(content), "utf8") + 2;
        if (bytes + cost > SESSION_AGENT_FILES_BYTES) return false;
        bytes += cost;
        out[path] = content;
        return true;
    };
    for (const file of files) {
        const agent = parseAgentFile(file.path, file.content);
        if (typeof agent === "string") continue;
        const base = fileBase(agent.name);
        if (!put(`.opencode/agent/${base}.md`, file.content)) break;
        if (agent.mode !== "primary" && !put(`.claude/agents/${base}.md`, claudeAgentFile(agent))) break;
    }
    return out;
}
