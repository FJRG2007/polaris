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
 *   - The agent authenticates as itself. On a machine somebody already signed the
 *     tool in on, that is the login already sitting in its own configuration and
 *     Polaris neither reads nor replaces it. In a container Polaris made, nothing
 *     is signed in to anything, so a session there is handed the credential its
 *     owner linked - see `credentials` below, and `agent-signins.ts`.
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
 * One way of signing an agent in.
 *
 * Every one of these is an environment variable, because that is what all of
 * these tools read and it is the only shape that works in a container nobody has
 * ever sat in front of. A tool signed in on the machine already needs none of
 * this: the variable is simply absent and its own configuration answers.
 */
export interface AgentCredential {
    /** The variable the tool reads it from. Its own name, never one of ours. */
    readonly env: string;
    /** What it is, in the words its vendor uses. Goes on the field that asks. */
    readonly label: string;
    /** Where somebody goes to get one. */
    readonly url: string;
    /**
     * How it is obtained, when that is not "copy it off the page above".
     *
     * A subscription token is the case that needs saying: it is minted by a
     * command the person runs where they are already signed in, and a screen that
     * only linked a page would be sending them somewhere with no field on it.
     */
    readonly howto: string | null;
    /**
     * True when this signs in an existing subscription rather than billing a key
     * per token. Worth telling apart on a screen: it is the difference between
     * "the plan you already pay for" and "a meter starts now".
     */
    readonly subscription: boolean;
}

/**
 * One command-line agent.
 *
 * Every field is something Polaris can act on. There is no marketing copy here
 * and no capability that is only ever displayed: an entry that cannot be checked
 * on a machine is an entry that will be wrong without anybody noticing.
 */
/**
 * One of the questions a tool asks the first time it is ever run, and the answer
 * written into its own configuration before it can ask.
 *
 * These are not settings Polaris has an opinion about. They are the wizard a
 * tool walks somebody through on a fresh machine - pick a colour scheme, pick a
 * login method - and on a machine nobody can see, that wizard is a session that
 * has stopped. It stopped in front of a menu that reads single keystrokes, so
 * the prompt Polaris then pasted was eaten by it rather than answered, and the
 * session sat there looking like an agent thinking hard. `autonomyArgs` says the
 * same thing about the trust menu; this is the same problem one screen earlier.
 *
 * Every key here has to be READ OFF a real installation of the tool - the file
 * it writes and the name it writes - never inferred from what a setting ought to
 * be called. A guessed key is silently ignored, which puts the session back in
 * front of the wizard with nothing to show why.
 *
 * They are filled in only where absent, so a person who later picks a light
 * theme keeps it: Polaris answers the question once and never overrules the
 * answer.
 */
export interface AgentFirstRunAnswer {
    /** The file, relative to the home of whoever runs the tool. JSON, and
     *  created if it is not there yet. */
    readonly file: string;
    /** The keys merged into it, filled in only where absent. Nested, because
     *  some of these answers are not a flag at the top of a file - see
     *  `FIRST_RUN_WORKDIR`. */
    readonly json: Readonly<Record<string, AgentFirstRunValue>>;
}

/** What an answer may be. Objects nest; everything else is a leaf that is
 *  written only where the file does not already have that key. */
export type AgentFirstRunValue =
    | string
    | number
    | boolean
    | { readonly [key: string]: AgentFirstRunValue };

/**
 * The key that stands for the directory the agent is working in.
 *
 * Some of what a tool asks the first time is not about the tool, it is about
 * the FOLDER - and the answer is recorded under the folder's own path. Claude
 * Code's "is this a project you trust?" is one: it is stored per project, so
 * there is no global answer to write, and a session's worktree is a path that
 * did not exist until a minute ago.
 *
 * Nobody is there to be asked, either. The question is about a checkout Polaris
 * made, of a repository the person picked a moment ago, inside a container
 * Polaris started - and the default answer on that screen is "No, exit", which
 * is exactly what the agent did. This is the same argument `autonomyArgs` makes
 * about the menu after it, so it is answered the same way.
 */
export const FIRST_RUN_WORKDIR = "{workdir}";

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
    /**
     * What signs this tool in, best first, and an empty list where Polaris does
     * not know.
     *
     * Empty is a real answer and it is load-bearing: it means nothing here has
     * been sourced from the vendor, so Polaris must not claim the tool is
     * unusable and must not block a session on it. A guessed variable name would
     * be worse than no answer at all - it reads as a fact, and the session it
     * refuses to start would be refused for a reason nobody can check.
     *
     * A machine that already has the tool signed in satisfies all of these
     * without any of them being set, which is why a missing credential is a
     * warning on the screen rather than a refusal on a server.
     */
    readonly credentials: readonly AgentCredential[];
    /**
     * What to add to the command so the tool actually starts working.
     *
     * The one per-vendor thing this file carries, and it is here because leaving
     * it out did not keep the catalogue clean - it produced a session that came
     * up, sat on its own "do you trust the files in this folder?" menu, and
     * reported nothing forever. From outside, that is indistinguishable from an
     * agent thinking hard, which is the worst failure this app can have.
     *
     * These menus read a single keystroke, so they eat the prompt as well: a
     * bracketed paste arriving at one selects an arbitrary option or quits the
     * session. There is no way to answer them from here and no reason to - the
     * session is a worktree Polaris made, in a container Polaris started, holding
     * a checkout of a repository the person picked a moment ago. Nobody is there
     * to be asked, and the thing being asked about did not exist a minute before.
     *
     * Empty where the tool asks nothing on startup, which is most of them.
     */
    readonly autonomyArgs: readonly string[];
    /** The same job where the tool takes a variable rather than a flag. */
    readonly autonomyEnv: Readonly<Record<string, string>>;
    /**
     * What its first run asks, answered in advance. Empty where nothing has been
     * sourced, which is a real answer and not a gap to fill in from memory - see
     * `AgentFirstRunAnswer`.
     */
    readonly firstRun: readonly AgentFirstRunAnswer[];
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
        install:
            "npm install -g --allow-scripts=@anthropic-ai/claude-code @anthropic-ai/claude-code",
        home: ".claude",
        observe: "hooks",
        docs: "https://docs.claude.com/en/docs/claude-code",
        credentials: [
            // The subscription first, deliberately. Most people running Claude
            // Code are running it on a plan rather than on metered credits, and a
            // screen that offered the API key first would be asking them to start
            // paying twice for the same work.
            {
                env: "CLAUDE_CODE_OAUTH_TOKEN",
                label: "Claude subscription",
                url: "https://docs.claude.com/en/docs/claude-code",
                howto: "Run `claude setup-token` wherever you are already signed in to Claude Code, and paste what it prints.",
                subscription: true
            },
            {
                env: "ANTHROPIC_API_KEY",
                label: "Anthropic API key",
                url: "https://console.anthropic.com/settings/keys",
                howto: null,
                subscription: false
            }
        ],
        autonomyArgs: ["--dangerously-skip-permissions"],
        autonomyEnv: {},
        // Read off an installed Claude Code, not inferred: the flag is the one
        // its own onboarding writes when somebody finishes the wizard, and it is
        // the one the startup path tests before showing it. The colour scheme is
        // the other half of that wizard and lives in the settings file rather
        // than beside the flag, which is exactly the kind of thing that has to be
        // looked up rather than assumed.
        //
        // Both screens were reported from a real session: it came up on "choose
        // the text style that looks best with your terminal", and the screen
        // after that offered to sign in - on a machine where Polaris had already
        // handed it a credential, and where nobody could answer either one.
        firstRun: [
            // The flag goes in TWO places, and that is not belt and braces - it
            // is that Claude Code has two homes and which one it reads depends
            // on how it was started.
            //
            // `CLAUDE_CONFIG_DIR` is its "configuration home", and the config
            // file moves INSIDE it. Enigma's launcher always sets that variable
            // (to `~/.claude` for the default account), and Polaris starts these
            // tools through Enigma whenever it is in the session - so the file
            // that is actually read is `.claude/.claude.json`. Writing only the
            // one beside it, which is where a plain `claude` keeps it, is a flag
            // set in a file nothing opens: the wizard came up anyway, and there
            // was nothing on the screen to say why.
            //
            // Both are written because Polaris starts the tool both ways: with
            // Enigma, and without it when the operator has turned it off.
            { file: ".claude/.claude.json", json: { hasCompletedOnboarding: true } },
            { file: ".claude.json", json: { hasCompletedOnboarding: true } },
            // Settings were always right: they live in the configuration home
            // under their own name, which is the same path either way.
            { file: ".claude/settings.json", json: { theme: "dark" } },
            // And the folder. Read off the tool's own message, which names the
            // key and says in as many words that setting it is the alternative
            // to accepting the dialog by hand: "accept the trust dialog here
            // once interactively, or set projects[...].hasTrustDialogAccepted".
            //
            // It goes only in the configuration home, because that is the file
            // this is stored in and there is no second place for it - unlike the
            // onboarding flag, which a bare launch keeps beside it.
            {
                file: ".claude/.claude.json",
                json: { projects: { [FIRST_RUN_WORKDIR]: { hasTrustDialogAccepted: true } } }
            }
        ]
    },
    {
        id: "codex",
        label: "Codex",
        vendor: "OpenAI",
        binaries: ["codex"],
        install: "npm install -g @openai/codex",
        home: ".codex",
        observe: "output",
        docs: "https://github.com/openai/codex",
        credentials: [
            {
                env: "OPENAI_API_KEY",
                label: "OpenAI API key",
                url: "https://platform.openai.com/api-keys",
                howto: null,
                subscription: false
            }
        ],
        autonomyArgs: ["--dangerously-bypass-approvals-and-sandbox"],
        autonomyEnv: {},
        firstRun: []
    },
    {
        id: "opencode",
        label: "OpenCode",
        vendor: "SST",
        binaries: ["opencode"],
        install: "npm install -g opencode-ai",
        home: ".config/opencode",
        observe: "output",
        docs: "https://opencode.ai/docs",
        credentials: [
            // Multi-provider: it reads whichever provider variables are set, so
            // either of these on its own is enough to get it started.
            {
                env: "ANTHROPIC_API_KEY",
                label: "Anthropic API key",
                url: "https://console.anthropic.com/settings/keys",
                howto: null,
                subscription: false
            },
            {
                env: "OPENAI_API_KEY",
                label: "OpenAI API key",
                url: "https://platform.openai.com/api-keys",
                howto: null,
                subscription: false
            }
        ],
        autonomyArgs: [],
        autonomyEnv: {},
        firstRun: []
    },
    {
        id: "gemini",
        label: "Gemini CLI",
        vendor: "Google",
        binaries: ["gemini"],
        install: "npm install -g @google/gemini-cli",
        home: ".gemini",
        observe: "output",
        docs: "https://github.com/google-gemini/gemini-cli",
        credentials: [
            {
                env: "GEMINI_API_KEY",
                label: "Google AI API key",
                url: "https://aistudio.google.com/apikey",
                howto: null,
                subscription: false
            }
        ],
        autonomyArgs: ["--yolo"],
        autonomyEnv: {},
        firstRun: []
    },
    {
        id: "copilot",
        label: "GitHub Copilot CLI",
        vendor: "GitHub",
        binaries: ["copilot"],
        install: "npm install -g @github/copilot",
        home: ".copilot",
        observe: "output",
        docs: "https://docs.github.com/en/copilot/concepts/agents/about-copilot-cli",
        credentials: [
            // Already satisfied in every session Polaris starts: the repository
            // is checked out with a GitHub App token that is exported under this
            // name, so this one never asks anybody for anything.
            {
                env: "GH_TOKEN",
                label: "GitHub token",
                url: "https://docs.github.com/en/copilot/concepts/agents/about-copilot-cli",
                howto: null,
                subscription: true
            }
        ],
        autonomyArgs: ["--yolo"],
        autonomyEnv: {},
        firstRun: []
    },
    {
        id: "cursor",
        label: "Cursor CLI",
        vendor: "Cursor",
        binaries: ["cursor-agent"],
        install: null,
        home: ".cursor",
        observe: "output",
        docs: "https://cursor.com/docs/cli/overview",
        credentials: [
            {
                env: "CURSOR_API_KEY",
                label: "Cursor API key",
                url: "https://cursor.com/docs/cli/overview",
                howto: null,
                subscription: false
            }
        ],
        autonomyArgs: ["--yolo"],
        autonomyEnv: {},
        firstRun: []
    },
    {
        id: "amp",
        label: "Amp",
        vendor: "Sourcegraph",
        binaries: ["amp"],
        install: "npm install -g @sourcegraph/amp",
        home: ".config/amp",
        observe: "output",
        docs: "https://ampcode.com/manual",
        credentials: [
            {
                env: "AMP_API_KEY",
                label: "Amp API key",
                url: "https://ampcode.com/settings",
                howto: null,
                subscription: false
            }
        ],
        autonomyArgs: [],
        autonomyEnv: {},
        firstRun: []
    },
    {
        id: "goose",
        label: "Goose",
        vendor: "Block",
        binaries: ["goose"],
        install: null,
        home: ".config/goose",
        observe: "output",
        docs: "https://block.github.io/goose/docs/quickstart",
        credentials: [
            {
                env: "ANTHROPIC_API_KEY",
                label: "Anthropic API key",
                url: "https://console.anthropic.com/settings/keys",
                howto: null,
                subscription: false
            },
            {
                env: "OPENAI_API_KEY",
                label: "OpenAI API key",
                url: "https://platform.openai.com/api-keys",
                howto: null,
                subscription: false
            }
        ],
        autonomyArgs: [],
        autonomyEnv: { GOOSE_MODE: "auto" },
        firstRun: []
    },
    {
        id: "aider",
        label: "Aider",
        vendor: "Aider",
        binaries: ["aider"],
        install: "python -m pip install aider-install && aider-install",
        home: ".aider",
        observe: "output",
        docs: "https://aider.chat/docs",
        credentials: [
            {
                env: "ANTHROPIC_API_KEY",
                label: "Anthropic API key",
                url: "https://console.anthropic.com/settings/keys",
                howto: null,
                subscription: false
            },
            {
                env: "OPENAI_API_KEY",
                label: "OpenAI API key",
                url: "https://platform.openai.com/api-keys",
                howto: null,
                subscription: false
            }
        ],
        autonomyArgs: [],
        autonomyEnv: {},
        firstRun: []
    },
    {
        id: "droid",
        label: "Droid",
        vendor: "Factory",
        binaries: ["droid"],
        install: null,
        home: ".factory",
        observe: "output",
        docs: "https://docs.factory.ai/cli/getting-started/quickstart",
        credentials: [
            {
                env: "FACTORY_API_KEY",
                label: "Factory API key",
                url: "https://docs.factory.ai/cli/getting-started/quickstart",
                howto: null,
                subscription: false
            }
        ],
        autonomyArgs: [],
        autonomyEnv: {},
        firstRun: []
    },
    {
        id: "qwen",
        label: "Qwen Code",
        vendor: "Alibaba",
        binaries: ["qwen"],
        install: "npm install -g @qwen-code/qwen-code",
        home: ".qwen",
        observe: "output",
        docs: "https://github.com/QwenLM/qwen-code",
        // It signs in through its own `/auth`, and which variable it reads for a
        // key was not something the documentation said plainly. Empty rather than
        // guessed: see the field.
        credentials: [],
        autonomyArgs: [],
        autonomyEnv: {},
        firstRun: []
    },
    {
        id: "crush",
        label: "Crush",
        vendor: "Charm",
        binaries: ["crush"],
        install: "npm install -g @charmland/crush",
        home: ".config/crush",
        observe: "output",
        docs: "https://github.com/charmbracelet/crush",
        credentials: [
            {
                env: "ANTHROPIC_API_KEY",
                label: "Anthropic API key",
                url: "https://console.anthropic.com/settings/keys",
                howto: null,
                subscription: false
            },
            {
                env: "OPENAI_API_KEY",
                label: "OpenAI API key",
                url: "https://platform.openai.com/api-keys",
                howto: null,
                subscription: false
            }
        ],
        autonomyArgs: [],
        autonomyEnv: {},
        firstRun: []
    },
    {
        id: "cline",
        label: "Cline",
        vendor: "Cline",
        binaries: ["cline"],
        install: "npm install -g cline",
        // Not sourced. A wrong one shows up as a tool Polaris cannot configure on
        // a machine that has it, which is worse than admitting it is unknown.
        home: null,
        observe: "output",
        docs: "https://github.com/cline/cline",
        credentials: [
            {
                env: "ANTHROPIC_API_KEY",
                label: "Anthropic API key",
                url: "https://console.anthropic.com/settings/keys",
                howto: null,
                subscription: false
            },
            {
                env: "OPENAI_API_KEY",
                label: "OpenAI API key",
                url: "https://platform.openai.com/api-keys",
                howto: null,
                subscription: false
            }
        ],
        autonomyArgs: [],
        autonomyEnv: {},
        firstRun: []
    },
    {
        id: "openhands",
        label: "OpenHands",
        vendor: "All Hands AI",
        binaries: ["openhands"],
        // Python rather than npm, which is why it is spelled out: the machine has
        // to have uv, and a machine that does not gets the "could not be
        // installed" refusal rather than a session that starts without it.
        install: "pip install openhands",
        home: null,
        observe: "output",
        docs: "https://docs.all-hands.dev",
        credentials: [
            {
                env: "ANTHROPIC_API_KEY",
                label: "Anthropic API key",
                url: "https://console.anthropic.com/settings/keys",
                howto: null,
                subscription: false
            },
            {
                env: "OPENAI_API_KEY",
                label: "OpenAI API key",
                url: "https://platform.openai.com/api-keys",
                howto: null,
                subscription: false
            }
        ],
        autonomyArgs: [],
        autonomyEnv: {},
        firstRun: []
    },
    {
        id: "openclaw",
        label: "OpenClaw",
        vendor: "OpenClaw",
        binaries: ["openclaw"],
        install: null,
        home: ".openclaw",
        observe: "output",
        docs: "https://github.com/openclaw/openclaw",
        credentials: [],
        autonomyArgs: [],
        autonomyEnv: {},
        firstRun: []
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
        docs: "",
        // Nothing is known about a command somebody typed, including what signs
        // it in. Empty means Polaris will not judge it - see the field.
        credentials: [],
        // Nor what it asks on startup, nor what it writes the answer into.
        // Whoever typed the command puts whatever flags it needs into it
        // themselves.
        autonomyArgs: [],
        autonomyEnv: {},
        firstRun: []
    };
}

/**
 * Which of a tool's credentials is actually in place, or null.
 *
 * The first one that answers, in the catalogue's own order, which is why the
 * order there is not alphabetical: a subscription is listed before the metered
 * key of the same vendor so a person holding both is reported as running on the
 * plan they already pay for.
 */
export function credentialInPlace(
    cli: AgentCli,
    present: (env: string) => boolean
): AgentCredential | null {
    return cli.credentials.find((credential) => present(credential.env)) ?? null;
}

/**
 * Whether a session can be expected to get anywhere, and what to say if not.
 *
 * Three answers rather than two, and the third is the one that matters. "ready"
 * and "missing" are the obvious pair; "unknown" is a tool Polaris has no sourced
 * credential for, and it must read as neither - a screen that showed it as
 * missing would be inventing a problem, and one that showed it as ready would be
 * promising something nobody checked.
 */
export type AgentReadiness = "ready" | "missing" | "unknown";

export function agentReadiness(cli: AgentCli, present: (env: string) => boolean): AgentReadiness {
    if (cli.credentials.length === 0) return "unknown";
    return credentialInPlace(cli, present) ? "ready" : "missing";
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

/**
 * Whether a session may run its agent past the tool's own permission prompts.
 *
 * The flags in `autonomyArgs` are what stop a session sitting on a trust menu
 * forever, and they are also the flags whose names say "dangerously". Both are
 * true, and which one matters depends entirely on WHERE the agent is running -
 * which is why this is a function of the place rather than a property of the
 * tool.
 *
 * In a container Polaris made, it is a sandbox: a clone of one repository, no
 * credential in it but the one that clone needed, and the whole thing removed
 * when the session ends. An agent that can run commands there without asking is
 * an agent working in a box built for it to work in, and refusing to would mean
 * every session waiting on a person who is not watching.
 *
 * On somebody's own server it is their machine. The agent runs as the account
 * Polaris enrolled, beside their SSH keys, their Docker socket and everything
 * else that account can reach, and a tool free to run any command there is a
 * different proposition entirely - one nobody chose by picking a repository from
 * a list. So the default there is off, and turning it on is a decision somebody
 * makes on purpose, in a sentence that says what it means.
 *
 * Null is "nobody said", which is the only value a session created before this
 * existed can have.
 */
export function agentRunsUnattended(place: "local" | "host", chosen: boolean | null): boolean {
    return chosen ?? place === "local";
}

/**
 * Whether POLARIS is the one to append those flags, or whether something else
 * has already settled it.
 *
 * Enigma is that something else. Installing it into a session is installing the
 * policies, conventions and guardrails an account keeps for its agents, and
 * deciding what the agent may run without asking is one of the things those
 * settle - so a session with Enigma in it has already been configured by the
 * time the agent starts, and Polaris adding a flag on top would be Polaris
 * overruling the settings somebody keeps precisely so they do not have to say
 * this twice.
 *
 * The two answers are not the same and the difference matters: "the agent runs
 * unattended" stays true either way, and what changes is who wrote it down.
 * Polaris only writes it where nobody else did.
 */
export function polarisAppliesAutonomy(
    place: "local" | "host",
    chosen: boolean | null,
    enigmaActive: boolean
): boolean {
    return !enigmaActive && agentRunsUnattended(place, chosen);
}

/**
 * The tools Enigma will start for you, rather than only configure.
 *
 * `enigma claude` is not a synonym for `claude`. It is the thing that makes the
 * settings actually apply: it syncs the skills first, stocks the account with
 * the memory file and the mirrored bypass and attribution settings, and picks
 * WHICH login to run under. Installing Enigma and then starting the bare binary
 * left half of that on the floor, which is the gap this closes - Polaris drops
 * its own autonomy flags the moment Enigma is in the session, on the
 * understanding that Enigma has already settled them, and that is only true
 * through this launcher.
 *
 * The other half is the reason this is worth a list at all: a launcher takes an
 * ACCOUNT. `enigma account add work --login` makes a second Claude login beside
 * the first, in its own configuration directory, and `enigma claude work` runs
 * under it - several logins on one machine with none of them signing the others
 * out. On a session whose home is kept between runs that is exactly the shape
 * somebody with a personal plan and a work plan needs, and it costs Polaris no
 * model of its own: the accounts live in the home, and the person makes them in
 * the session's own terminal.
 *
 * Named rather than derived, and short on purpose. A tool Enigma does not launch
 * gets started directly, which is what it did before.
 */
const ENIGMA_LAUNCHES: readonly string[] = ["claude", "codex", "opencode"];

/**
 * The picker's value for "sign it in with nothing and let the machine answer".
 *
 * Here rather than beside the option builder because a browser reads it: that
 * builder reaches the stored credentials and so reaches the database, and a
 * client component importing a value out of it drags the whole server module
 * into the bundle. A word rather than an id, so a value that ever reached a log
 * says what it meant.
 */
export const MACHINE_LOGIN_KEY = "machine";

/** Whether Enigma should be the one to start this tool. */
export function enigmaLaunches(cliId: string): boolean {
    return ENIGMA_LAUNCHES.includes(cliId);
}
