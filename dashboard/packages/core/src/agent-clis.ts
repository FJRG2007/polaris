/**
 * The coding-agent command-line tools Polaris knows how to run a session with.
 *
 * Two ways exist to put a model to work on a repository, and this file is the
 * second one. The first is the runtime Polaris already ships: a headless job that
 * is handed a prompt, works alone, and opens a pull request. It is the right
 * shape for "review every pull request", and the wrong shape for "sit with me
 * while I get this done".
 *
 * A session is the other shape. Polaris starts the vendor's OWN command-line
 * tool - `claude`, `codex`, `opencode` - as a real process on a real machine, in
 * a git worktree of its own, and then steers it: prompts go in, output comes
 * back, and the person watching can interrupt, answer a question, or take the
 * terminal over. Nothing here talks to a model API. That is the point:
 *
 *   - The agent authenticates the way it already does on that machine. A Claude
 *     subscription, a Codex login, a key in the tool's own configuration - none
 *     of it has to be re-entered into Polaris, and Polaris never holds it.
 *   - Whatever the vendor ships - its permission prompts, its sandboxing, its own
 *     tool allowlist, its context management - keeps working, because it is the
 *     vendor's binary doing the work rather than a re-implementation of it.
 *   - A tool Polaris has never heard of still runs, because running one is
 *     spawning a command. The catalogue below is what Polaris can be helpful
 *     ABOUT, not the set of things it will consent to start.
 *
 * The entries are deliberately thin. A binary name, where the tool keeps its
 * configuration, and how Polaris can tell what it is doing. Flags and models are
 * the tool's business and change faster than any list here could - so a session
 * starts the bare command and talks to it the way a person would, rather than
 * encoding a command line per vendor that would rot in a month.
 */

/** How Polaris can tell what a running session is doing. */
export const AGENT_OBSERVATIONS = ["hooks", "output"] as const;
export type AgentObservation = (typeof AGENT_OBSERVATIONS)[number];

/**
 * What each observation costs and buys.
 *
 * `hooks` is the good case: the tool supports lifecycle hooks in its own
 * configuration, so Polaris registers a small script that reports each turn, each
 * tool call and each permission prompt as it happens. It is exact, and it works
 * whether or not anybody has the terminal open.
 *
 * `output` is the fallback for a tool with no hooks at all: Polaris watches what
 * the process prints - including the window title it sets, which most of these
 * use to say whether they are thinking or waiting. Good enough to tell working
 * from idle, and never more than that.
 */
export const AGENT_OBSERVATION_NOTES: Record<AgentObservation, string> = {
    hooks: "Reports each turn and tool call through the tool's own lifecycle hooks.",
    output: "Read from what the tool prints, so Polaris can tell working from waiting and no more."
};

/**
 * One command-line agent.
 *
 * Every field is something Polaris can act on. There is no marketing copy here
 * and no capability that is only ever displayed: an entry that cannot be checked
 * on a machine is an entry that will be wrong without anybody noticing.
 */
export interface AgentCli {
    /** Stable id. Stored on a session, so it never changes once shipped. */
    readonly id: string;
    readonly label: string;
    readonly vendor: string;
    /**
     * Commands to look for on PATH, best first. More than one because a tool that
     * renames its binary keeps the old name working for a while, and a session
     * started against the old name has to keep resolving.
     */
    readonly binaries: readonly string[];
    /**
     * How to install it, in the words the operator would type on the machine that
     * is missing it. Null where installation is not a single command - the screen
     * then links the documentation instead of pretending otherwise.
     */
    readonly install: string | null;
    /**
     * The directory the tool keeps its own configuration in, relative to the home
     * of whoever runs it. Where the managed hooks go, and what a session has to
     * carry with it when it runs somewhere other than the operator's own machine.
     */
    readonly home: string | null;
    readonly observe: AgentObservation;
    /** The tool's own documentation, for the screen that could not find it. */
    readonly docs: string;
}

/**
 * The tools Polaris ships knowing about.
 *
 * Anything absent still runs - see `customAgentCli` - so the bar for being here
 * is not "somebody uses it", it is "Polaris can say something true about it
 * without being told". Every binary name and configuration directory below is one
 * Polaris probes for on the machine, so a wrong one shows up as "not found" on a
 * machine that has the tool, rather than as a session that fails to start.
 */
export const AGENT_CLIS: readonly AgentCli[] = [
    {
        id: "claude",
        label: "Claude Code",
        vendor: "Anthropic",
        binaries: ["claude"],
        install: "npm install -g @anthropic-ai/claude-code",
        home: ".claude",
        observe: "hooks",
        docs: "https://docs.claude.com/en/docs/claude-code"
    },
    {
        id: "codex",
        label: "Codex",
        vendor: "OpenAI",
        binaries: ["codex"],
        install: "npm install -g @openai/codex",
        home: ".codex",
        observe: "output",
        docs: "https://github.com/openai/codex"
    },
    {
        id: "opencode",
        label: "OpenCode",
        vendor: "SST",
        binaries: ["opencode"],
        install: "npm install -g opencode-ai",
        home: ".config/opencode",
        observe: "output",
        docs: "https://opencode.ai/docs"
    },
    {
        id: "gemini",
        label: "Gemini CLI",
        vendor: "Google",
        binaries: ["gemini"],
        install: "npm install -g @google/gemini-cli",
        home: ".gemini",
        observe: "output",
        docs: "https://github.com/google-gemini/gemini-cli"
    },
    {
        id: "copilot",
        label: "GitHub Copilot CLI",
        vendor: "GitHub",
        binaries: ["copilot"],
        install: "npm install -g @github/copilot",
        home: ".copilot",
        observe: "output",
        docs: "https://docs.github.com/en/copilot/concepts/agents/about-copilot-cli"
    },
    {
        id: "cursor",
        label: "Cursor CLI",
        vendor: "Cursor",
        binaries: ["cursor-agent"],
        install: null,
        home: ".cursor",
        observe: "output",
        docs: "https://cursor.com/docs/cli/overview"
    },
    {
        id: "amp",
        label: "Amp",
        vendor: "Sourcegraph",
        binaries: ["amp"],
        install: "npm install -g @sourcegraph/amp",
        home: ".config/amp",
        observe: "output",
        docs: "https://ampcode.com/manual"
    },
    {
        id: "goose",
        label: "Goose",
        vendor: "Block",
        binaries: ["goose"],
        install: null,
        home: ".config/goose",
        observe: "output",
        docs: "https://block.github.io/goose/docs/quickstart"
    },
    {
        id: "aider",
        label: "Aider",
        vendor: "Aider",
        binaries: ["aider"],
        install: "python -m pip install aider-install && aider-install",
        home: ".aider",
        observe: "output",
        docs: "https://aider.chat/docs"
    },
    {
        id: "droid",
        label: "Droid",
        vendor: "Factory",
        binaries: ["droid"],
        install: null,
        home: ".factory",
        observe: "output",
        docs: "https://docs.factory.ai/cli/getting-started/quickstart"
    },
    {
        id: "openclaw",
        label: "OpenClaw",
        vendor: "OpenClaw",
        binaries: ["openclaw"],
        install: null,
        home: ".openclaw",
        observe: "output",
        docs: "https://github.com/openclaw/openclaw"
    }
];

/** The id every session that names its own command carries. */
export const CUSTOM_AGENT_CLI = "custom";

/** An entry for a tool Polaris was never told about, built from what the operator
 *  typed. It is observed from its output, because nothing is known about its
 *  configuration - and it runs exactly like a catalogued one otherwise. */
export function customAgentCli(command: string): AgentCli {
    const binary = command.trim().split(/\s+/)[0] ?? "";
    return {
        id: CUSTOM_AGENT_CLI,
        label: binary || "Custom agent",
        vendor: "",
        binaries: binary ? [binary] : [],
        install: null,
        home: null,
        observe: "output",
        docs: ""
    };
}

/** The catalogued tool with this id, or null. `custom` is deliberately not one:
 *  it has no fixed definition, and asking for it by id is a caller that forgot. */
export function agentCliById(id: string): AgentCli | null {
    return AGENT_CLIS.find((cli) => cli.id === id) ?? null;
}

/** Whether `id` names something a session may be started with at all. */
export function isKnownAgentCli(id: string): boolean {
    return id === CUSTOM_AGENT_CLI || AGENT_CLIS.some((cli) => cli.id === id);
}

/**
 * What a machine turned out to have.
 *
 * `path` is the resolved command, which is what a session is actually started
 * with: probing finds `claude` on a PATH that a login shell builds, and a session
 * that re-resolved the bare name later could land somewhere else or nowhere.
 */
export interface AgentCliPresence {
    readonly id: string;
    /** The binary that answered, of the ones tried. */
    readonly binary: string;
    /** Its absolute path on that machine. */
    readonly path: string;
    /** What it says its version is, when it was willing to say. */
    readonly version: string | null;
}

/**
 * Which of the catalogued tools a machine has, given something that can look one
 * up on it.
 *
 * The probe is passed in rather than done here so this stays pure and testable:
 * on the Polaris box it shells out through the host daemon, on an enrolled server
 * it runs over SSH, and neither belongs in the domain layer. A probe that throws
 * is treated as "not there" - a machine that cannot answer about one tool must
 * still report the others rather than failing the whole scan.
 */
export async function detectAgentClis(
    probe: (binary: string) => Promise<AgentCliPresence | null>,
    catalogue: readonly AgentCli[] = AGENT_CLIS
): Promise<AgentCliPresence[]> {
    const found: AgentCliPresence[] = [];
    for (const cli of catalogue) {
        for (const binary of cli.binaries) {
            let presence: AgentCliPresence | null = null;
            try {
                presence = await probe(binary);
            } catch {
                presence = null;
            }
            if (presence) {
                found.push({ ...presence, id: cli.id, binary });
                break;
            }
        }
    }
    return found;
}

/**
 * Read the version out of what a tool printed when asked for one.
 *
 * Every one of these answers `--version` differently - a bare number, a name and
 * a number, a banner with the number somewhere in it - so the first thing that
 * looks like a version is taken and the rest is dropped. A tool that printed
 * nothing useful gets a null version rather than a line of its banner, because a
 * banner on a screen that says "version" is worse than an empty cell.
 */
export function parseAgentCliVersion(output: string): string | null {
    const match = /\b\d+\.\d+(?:\.\d+)?(?:[-+][0-9A-Za-z.-]+)?\b/.exec(output);
    return match ? match[0] : null;
}
