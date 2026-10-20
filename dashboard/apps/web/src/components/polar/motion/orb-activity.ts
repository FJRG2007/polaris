/**
 * Which thinking orb shows what Polar is doing right now, worked out from the
 * parts the chat stream has already delivered - no extra event, no guess.
 *
 * - waiting for the first word: breathing
 * - the model thinking (a reasoning part still streaming): solving
 * - one tool running: searching for a search or a lookup, shaping for files
 *   and attachments, connecting for an outside connector, working otherwise
 * - more than one tool running at once: weaving
 * - the answer being written: composing
 * - the stream reconnecting: connecting; voice input: listening
 */

import type { OrbState } from "./orb-engine/presets";

/** The slice of a chat message part this needs. */
export interface ActivityPart {
    type: string;
    state?: string;
    toolName?: string;
    text?: string;
}

export interface Activity {
    /** The chat's status: `submitted`, `streaming`, `ready` or `error`. */
    status: string;
    /** The parts of the message being answered, oldest first. */
    parts: readonly ActivityPart[];
    /** The stream dropped and is being picked up again. */
    reconnecting?: boolean;
    /** The microphone is open and Polar is listening. */
    listening?: boolean;
}

const RUNNING = new Set(["input-streaming", "input-available"]);
// Matched against the words of a tool's name (`polaris_search` -> polaris, search).
const SEARCH = new Set(["search", "find", "query", "lookup", "browse", "fetch", "web"]);
const FILES = new Set(["drive", "file", "files", "attachment", "document", "upload", "parse"]);
const CONNECTOR = new Set(["mcp", "connector", "connectors"]);

/** A tool part's own name, or null for a part that is not a tool call. */
export function toolNameOf(part: ActivityPart): string | null {
    if (part.type === "dynamic-tool") return part.toolName ?? "tool";
    if (part.type.startsWith("tool-")) return part.type.slice(5);
    return null;
}

/** The orb for one running tool, by what its name says it does. */
export function orbForTool(part: ActivityPart): OrbState {
    const name = (toolNameOf(part) ?? "").toLowerCase();
    const words = name.split(/[^a-z0-9]+/);
    const has = (set: Set<string>) => words.some((word) => set.has(word));
    // A namespaced name (`server__tool`) is a connector's tool.
    if (part.type === "dynamic-tool" || name.includes("__") || has(CONNECTOR)) return "connecting";
    if (has(SEARCH)) return "searching";
    if (has(FILES)) return "shaping";
    return "working";
}

/** The orb for this instant, or null when Polar is doing nothing. */
export function orbForActivity(activity: Activity): OrbState | null {
    if (activity.listening) return "listening";
    if (activity.reconnecting) return "connecting";
    if (activity.status === "submitted") return "breathing";
    if (activity.status !== "streaming") return null;
    const running = activity.parts.filter(
        (part) => toolNameOf(part) !== null && RUNNING.has(part.state ?? "")
    );
    if (running.length > 1) return "weaving";
    if (running.length === 1) return orbForTool(running[0]!);
    const last = activity.parts.at(-1);
    if (!last) return "breathing";
    if (last.type === "reasoning") return "solving";
    if (last.type === "text") return "composing";
    return "breathing";
}
