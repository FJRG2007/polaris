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
    /**
     * Where the tool keeps this credential itself, relative to its home, for a
     * login that writes a file rather than handing out a string.
     *
     * Absent for everything read from the environment. Present, the `env` is
     * Polaris's own name for the stored copy - no tool reads it - and a session
     * writes the copy into this file when the home has none, so a login done
     * once survives a home that was cleared.
     */
    readonly file?: string;
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
 * Two rules, and which one an answer takes is the whole of it. `json` is filled
 * in only where the file is silent, so a person who later picks a light theme
 * keeps it. `assert` is written whatever the file already says, for the answers
 * that were never the person's to give - see `CLAUDE_WIZARD_ANSWER`.
 */
export interface AgentFirstRunAnswer {
    /** The file, relative to the home of whoever runs the tool. JSON, and
     *  created if it is not there yet. */
    readonly file: string;
    /**
     * The keys written into it whatever it already says.
     *
     * For the answers that are Polaris's to give rather than the person's: the
     * wizard itself, on a screen nobody could reach, which only the agent that
     * met it can have answered already. See `CLAUDE_WIZARD_ANSWER` for why that
     * is not the same thing as overruling somebody.
     *
     * Nothing is written when the file already says the same, so a session that
     * has nothing to do stays silent. A branch that is there but is not an
     * object is replaced rather than walked away from: an answer that is
     * Polaris's to give is not left unwritten, and unsaid, because the file
     * holds something unreadable where it goes.
     */
    readonly assert?: Readonly<Record<string, AgentFirstRunValue>>;
    /** The keys merged into it, filled in only where absent. Nested, because
     *  some of these answers are not a flag at the top of a file - see
     *  `FIRST_RUN_WORKDIR`. Left out where every answer for the file is
     *  asserted. */
    readonly json?: Readonly<Record<string, AgentFirstRunValue>>;
}

/** What an answer may be. Objects nest; everything else is a leaf, written
 *  where the file does not already have that key - or whatever it says there,
 *  when the answer is asserted. */
export type AgentFirstRunValue =
    | string
    | number
    | boolean
    | readonly AgentFirstRunValue[]
    | { readonly [key: string]: AgentFirstRunValue };

/**
 * The one command every tool's hook configuration runs.
 *
 * Fixed text, and the same in every home: a container home is shared by every
 * session that account runs, so a hook naming one session's script would report
 * every other session's events as that one's. The session it belongs to is
 * whichever exported `POLARIS_STATE_DIR` into the agent's environment, and a
 * tool started anywhere else - the sign-in container, a terminal somebody
 * opened by hand - finds no script and reports nothing.
 *
 * It prints `{}` either way: Codex and Gemini CLI read a hook's output as JSON,
 * and an empty object is the answer that changes nothing.
 */
export const AGENT_HOOK_RELAY =
    'h="$POLARIS_STATE_DIR/hook.sh"; if [ -n "$POLARIS_STATE_DIR" ] && [ -x "$h" ]; then exec "$h"; fi; cat >/dev/null; printf "{}"';

/** Seconds a hook may take before the tool gives up on it. */
const HOOK_TIMEOUT_SECONDS = 5;

/**
 * Codex's lifecycle hooks, in `~/.codex/hooks.json`.
 *
 * Format and event names from Codex's hooks documentation: the same shape as
 * Claude Code's, `session_id` and `transcript_path` on stdin, `Stop` at the end
 * of every turn and `PermissionRequest` before an approval prompt. Hooks are on
 * by default.
 */
export const CODEX_HOOK_EVENTS = [
    "SessionStart",
    "UserPromptSubmit",
    "PreToolUse",
    "PostToolUse",
    "PermissionRequest",
    "Stop",
    "PostCompact",
    "SessionEnd"
] as const;

function codexHooks(): Record<string, AgentFirstRunValue> {
    const hook = { type: "command", command: AGENT_HOOK_RELAY, timeout: HOOK_TIMEOUT_SECONDS };
    const hooks: Record<string, AgentFirstRunValue> = {};
    for (const event of CODEX_HOOK_EVENTS) hooks[event] = [{ hooks: [hook] }];
    return { hooks };
}

/**
 * Gemini CLI's hooks, in the `hooks` object of `~/.gemini/settings.json`.
 *
 * Event names from its hooks reference. The payload carries `session_id`,
 * `transcript_path` and `hook_event_name` like the others; timeouts are in
 * milliseconds here, not seconds.
 */
export const GEMINI_HOOK_EVENTS = [
    "SessionStart",
    "BeforeAgent",
    "BeforeTool",
    "AfterTool",
    "AfterAgent",
    "Notification",
    "PreCompress",
    "SessionEnd"
] as const;

function geminiHooks(): Record<string, AgentFirstRunValue> {
    const hook = {
        name: "polaris",
        type: "command",
        command: AGENT_HOOK_RELAY,
        timeout: HOOK_TIMEOUT_SECONDS * 1000
    };
    const hooks: Record<string, AgentFirstRunValue> = {};
    for (const event of GEMINI_HOOK_EVENTS) {
        hooks[event] =
            event === "BeforeTool" || event === "AfterTool"
                ? [{ matcher: "*", hooks: [hook] }]
                : [{ hooks: [hook] }];
    }
    return { hooks };
}

/**
 * Copilot CLI's hooks: a file of its own under `~/.copilot/hooks/`, version 1,
 * camelCase events and payloads (`sessionId`, `toolName`, `toolArgs`).
 */
export const COPILOT_HOOK_EVENTS = [
    "sessionStart",
    "userPromptSubmitted",
    "preToolUse",
    "postToolUse",
    "permissionRequest",
    "notification",
    "agentStop",
    "errorOccurred",
    "sessionEnd"
] as const;

function copilotHooks(): Record<string, AgentFirstRunValue> {
    const hooks: Record<string, AgentFirstRunValue> = {};
    // Its payload does not name the event, so each registration does.
    for (const event of COPILOT_HOOK_EVENTS) {
        const bash = `export POLARIS_HOOK_EVENT=${event}; ${AGENT_HOOK_RELAY}`;
        hooks[event] = [{ type: "command", bash, timeoutSec: HOOK_TIMEOUT_SECONDS }];
    }
    return { version: 1, hooks };
}

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

/**
 * Everything a fresh Claude Code asks before it will run, asserted rather than
 * filled in.
 *
 * One object rather than one per question because the file is the unit: which
 * of the two config files gets read is decided by `CLAUDE_CONFIG_DIR` and not
 * by the key, so both files need all of it - and answering a file once is one
 * read-modify-write and one line on the terminal naming the file it wrote.
 *
 * Asserted, and the difference is not a detail. A colour scheme is filled in
 * only where the file is silent, because choosing one is somebody's to do.
 * Neither of these is: they ARE the wizard, so the only thing that can have
 * answered them already is an agent that met the screen before Polaris knew to.
 *
 * The home outlives every session and the container's path is a constant, so the
 * FIRST session - the one that met these screens before Polaris knew to answer
 * them - left `hasTrustDialogAccepted: false` under that exact path, chosen by an
 * agent hitting the highlighted option, which is "No, exit", where nobody could
 * see it. A recorded `hasCompletedOnboarding: false` is the same thing one screen
 * earlier. Fill-if-absent then finds an answer, writes nothing, prints nothing,
 * and the wizard comes back with the terminal silent - the precise invisible
 * failure the line naming each written file exists to prevent. Every deployment
 * that has already run a session is in that state right now.
 *
 * Those values are not somebody's decision. They are the absence of one,
 * recorded. Polaris made the folder, cloned into it, and started the container
 * around it, so it is Polaris's answer to give - and only ever where Polaris
 * made it: this runs nowhere but in a home Polaris owns, and the only folder it
 * writes under is the worktree of the session being started.
 */
const CLAUDE_WIZARD_ANSWER: Readonly<Record<string, AgentFirstRunValue>> = {
    hasCompletedOnboarding: true,
    // The warning a session meets when it runs with permissions bypassed, which
    // it does whenever Polaris or Enigma set it so. Its highlighted option is
    // "No, exit", and the first prompt is typed and entered straight onto it -
    // so the agent quit on the person's first message, before reading it, and
    // the session just said it had stopped. The choice to bypass was already
    // made by whoever set the mode; this is only that screen, answered. Checked
    // against Claude Code 2.1.257: with it the session opens on the prompt.
    bypassPermissionsModeAccepted: true,
    projects: { [FIRST_RUN_WORKDIR]: { hasTrustDialogAccepted: true } }
};

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
    /**
     * The flags that run one turn without the tool's full-screen interface:
     * the prompt on standard input, the answer printed, the process gone. A
     * session of a tool that has them runs every prompt this way, so nothing
     * has to be typed into a terminal or wait for one to look ready; the
     * interface itself is still there for whoever opens it.
     *
     * Absent where the flags have not been checked against the tool's own
     * documentation, and such a tool keeps its interactive terminal.
     */
    readonly headless?: readonly string[];
    /**
     * How the tool is told which model to run on, where its own documentation
     * says so: the variable it reads or the flag it takes, and the provider in
     * the public model index whose models it can run. Absent where nothing has
     * been sourced; such a tool runs on whatever its own sign-in defaults to.
     */
    readonly model?: AgentModelSupport;
}

/** See `AgentCli.model`. Exactly one of `env` and `flag`. */
export interface AgentModelSupport {
    /** The provider's id in the public model index (models.dev). */
    readonly provider: string;
    readonly env?: string;
    readonly flag?: string;
    /** Where the variable or flag is documented. */
    readonly docs: string;
}

/**
 * A model id that can go on a command line as it is: letters, digits and the
 * punctuation model ids use. Anything else is refused before a session starts.
 */
export const SAFE_MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/@\[\]-]{0,199}$/;

/** Whether this tool can be given a model by Polaris at all. */
export function agentTakesModel(cliId: string): boolean {
    return Boolean(agentCliById(cliId)?.model);
}

/** The variable that tells a tool its model, or nothing for one that is
 *  told on its command line, takes none, or was handed an unsafe id. */
export function agentModelEnv(cliId: string, model: string | null | undefined): Record<string, string> {
    const support = agentCliById(cliId)?.model;
    if (!support?.env || !model || !SAFE_MODEL_ID.test(model)) return {};
    return { [support.env]: model };
}

/** The words that tell a tool its model on its command line; none for one
 *  told by a variable, one that takes none, or an unsafe id. */
export function agentModelArgs(cliId: string, model: string | null | undefined): string[] {
    const support = agentCliById(cliId)?.model;
    if (!support?.flag || !model || !SAFE_MODEL_ID.test(model)) return [];
    return [support.flag, model];
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
            //
            // The folder is answered in both for the same reason. Read off the
            // tool's own message, which names the key and says in as many words
            // that setting it is the alternative to accepting the dialog by
            // hand: "accept the trust dialog here once interactively, or set
            // projects[...].hasTrustDialogAccepted". It lives in whichever of
            // the two files is being read, exactly as the flag above it does, so
            // a bare launch with Enigma off finds it answered too.
            { file: ".claude/.claude.json", assert: CLAUDE_WIZARD_ANSWER },
            { file: ".claude.json", assert: CLAUDE_WIZARD_ANSWER },
            // Settings were always right: they live in the configuration home
            // under their own name, which is the same path either way.
            { file: ".claude/settings.json", json: { theme: "dark" } }
        ],
        // code.claude.com/docs/en/headless: `-p` reads the prompt from standard
        // input, runs hooks from `--settings`, and shows no trust dialog.
        headless: ["-p"],
        model: {
            provider: "anthropic",
            env: "ANTHROPIC_MODEL",
            docs: "https://code.claude.com/docs/en/model-config"
        }
    },
    {
        id: "codex",
        label: "Codex",
        vendor: "OpenAI",
        binaries: ["codex"],
        install: "npm install -g @openai/codex",
        home: ".codex",
        observe: "hooks",
        docs: "https://github.com/openai/codex",
        credentials: [
            // The ChatGPT plan first, for the same reason Claude's subscription
            // is first. `codex login --device-auth` writes it to
            // `~/.codex/auth.json`; Polaris keeps a copy of that file.
            {
                env: "CODEX_CHATGPT_AUTH",
                label: "ChatGPT plan",
                url: "https://developers.openai.com/codex/auth",
                howto: null,
                subscription: true,
                file: ".codex/auth.json"
            },
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
        // No wizard to answer - the trust question is what the autonomy flag
        // covers - only the hooks that let Polaris see its turns.
        firstRun: [{ file: ".codex/hooks.json", assert: codexHooks() }],
        model: {
            provider: "openai",
            flag: "--model",
            docs: "https://learn.chatgpt.com/docs/developer-commands?surface=cli"
        }
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
        observe: "hooks",
        docs: "https://github.com/google-gemini/gemini-cli",
        credentials: [
            // A Google account: the free tier or a Google AI Pro / Ultra plan.
            // The CLI caches it in `~/.gemini/oauth_creds.json`.
            {
                env: "GEMINI_GOOGLE_AUTH",
                label: "Google account",
                url: "https://github.com/google-gemini/gemini-cli/blob/main/docs/get-started/authentication.mdx",
                howto: null,
                subscription: true,
                file: ".gemini/oauth_creds.json"
            },
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
        // The theme is what its first screen asks on a blank home (`ui.theme`,
        // left alone once somebody picked one). Folder trust is off by
        // default, so nothing to answer there.
        firstRun: [
            { file: ".gemini/settings.json", json: { ui: { theme: "Default" } } },
            { file: ".gemini/settings.json", assert: geminiHooks() }
        ],
        model: {
            provider: "google",
            env: "GEMINI_MODEL",
            docs: "https://github.com/google-gemini/gemini-cli/blob/main/docs/reference/configuration.md"
        }
    },
    {
        id: "copilot",
        label: "GitHub Copilot CLI",
        vendor: "GitHub",
        binaries: ["copilot"],
        install: "npm install -g @github/copilot",
        home: ".copilot",
        observe: "hooks",
        docs: "https://docs.github.com/en/copilot/concepts/agents/about-copilot-cli",
        credentials: [
            // `copilot login --device-code`. With no keychain in the container
            // the CLI offers to keep the token in `~/.copilot/config.json`.
            {
                env: "COPILOT_DEVICE_AUTH",
                label: "GitHub Copilot plan",
                url: "https://docs.github.com/en/copilot/how-tos/copilot-cli/set-up-copilot-cli/authenticate-copilot-cli",
                howto: null,
                subscription: true,
                file: ".copilot/config.json"
            },
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
        firstRun: [{ file: ".copilot/hooks/polaris.json", assert: copilotHooks() }]
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
 * How a session's agent asks before it acts, picked when it starts.
 *
 * - `ask`: every action that needs a permission is put to the person, on the
 *   session and on their devices, and nothing happens until they answer.
 * - `edits`: file edits go ahead; commands and the rest are asked.
 * - `plan`: the agent reads and plans and changes nothing.
 * - `full`: it acts without asking, as a session did before this existed.
 *
 * Only Claude Code's prompt is answered from Polaris (its hook decision is
 * Claude Code's own shape), so only Claude Code takes one; for every other tool
 * the place and Enigma decide, exactly as before.
 */
export const SESSION_PERMISSION_MODES = ["ask", "edits", "plan", "full"] as const;
export type SessionPermissionMode = (typeof SESSION_PERMISSION_MODES)[number];

const CLAUDE_PERMISSION_MODES: Record<SessionPermissionMode, string> = {
    ask: "default",
    edits: "acceptEdits",
    plan: "plan",
    full: "bypassPermissions"
};

/** A stored mode read back, or null for one this version does not know. */
export function sessionPermissionMode(
    raw: string | null | undefined
): SessionPermissionMode | null {
    return (SESSION_PERMISSION_MODES as readonly string[]).includes(raw ?? "")
        ? (raw as SessionPermissionMode)
        : null;
}

/** Whether a tool takes a permission mode from Polaris. */
export function takesPermissionMode(cliId: string): boolean {
    return cliId === "claude";
}

/**
 * The launch flags a picked mode means, or null when there is none to apply -
 * no mode picked, or a tool that does not take one - and the place and Enigma
 * decide. A flag rather than a setting because flags outrank every settings
 * file, the account's bypass included.
 */
export function permissionModeArgs(
    cliId: string,
    mode: SessionPermissionMode | null
): readonly string[] | null {
    if (!mode || !takesPermissionMode(cliId)) return null;
    return ["--permission-mode", CLAUDE_PERMISSION_MODES[mode]];
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
