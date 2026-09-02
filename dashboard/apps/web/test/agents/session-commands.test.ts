/**
 * The commands a session is made of, and the hooks that report on it.
 *
 * None of this can be run here - it wants Docker, an enrolled server and
 * somebody's repository - so the builders are asserted instead. What is checked
 * is the part a reading would not catch: that nothing from a prompt reaches a
 * shell unquoted, that the boot script interpolates nothing at all, and that an
 * event Polaris does not recognise moves nothing.
 */

import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import * as core from "@polaris/core";
import * as commands from "@/lib/agents/session-commands";
import { bootProgress } from "@/lib/agents/boot-progress";
import {
    claudeHookSettings,
    hookEventFailed,
    hookScript,
    normalizeHookEvent,
    shellQuote
} from "@/lib/agents/session-hooks";

const ESC = String.fromCharCode(27);

describe("the boot script", () => {
    it("interpolates nothing, so no repository name or prompt ever reaches a shell through it", () => {
        expect(commands.SESSION_SETUP).not.toMatch(/\$\{/);
    });

    it("reads every value it needs from the environment", () => {
        for (const name of [
            "GIT_AUTH_HEADER",
            "GITHUB_REPOSITORY",
            "POLARIS_WORKDIR",
            "POLARIS_BRANCH",
            "POLARIS_AGENT_COMMAND",
            "POLARIS_HOOK_SETTINGS"
        ]) {
            expect(commands.SESSION_SETUP).toContain(`$${name}`);
        }
    });

    it("drops the clone credential before the agent can read its own environment", () => {
        const boot = commands.SESSION_SETUP;
        // Against the exec rather than a `tmux new-session`: the agent takes
        // over the window the setup ran in, so there is no second session to
        // order against any more.
        // Against the line that runs the agent: the credential is dropped
        // before anything the agent could read its own environment from.
        const runs = boot.indexOf('as_agent "cd ');
        expect(runs).toBeGreaterThan(0);
        expect(boot.indexOf("unset GIT_AUTH_HEADER")).toBeLessThan(runs);
    });

    it("configures Enigma before it clears the variable that says how", () => {
        // The bug: the unset listed POLARIS_ENIGMA_CONFIGURE two lines above the
        // `if` that tested it, so every session installed Enigma and then
        // applied none of the settings the resolution had landed on. Silently -
        // an empty variable is an `if` that simply does not fire.
        expect(commands.SESSION_SETUP.indexOf("$POLARIS_ENIGMA_CONFIGURE | base64 -d")).toBe(-1);
        expect(
            commands.SESSION_SETUP.indexOf('printf %s "$POLARIS_ENIGMA_CONFIGURE" | base64 -d')
        ).toBeLessThan(commands.SESSION_SETUP.indexOf("unset POLARIS_HOOK_SCRIPT"));
    });

    it("decodes the files it writes rather than carrying them raw", () => {
        // The bug this replaced: all three of these are files, every file has
        // newlines, and the host daemon refuses any environment value carrying a
        // control character - so every session on this box was refused before it
        // started, with a message naming a variable nobody had ever seen. They
        // travel base64 now, which that rule has nothing to object to.
        for (const name of ["POLARIS_HOOK_SCRIPT", "POLARIS_HOOK_SETTINGS", "POLARIS_MCP_CONFIG"]) {
            expect(commands.SESSION_SETUP).toContain(`printf %s "$${name}" | base64 -d`);
        }
    });

    it("goes to the daemon as one argument with nothing in it the daemon refuses", () => {
        // The second half of the same bug, and the one that was still live after
        // the first was fixed. The host daemon refuses a control character in a
        // command ARGUMENT exactly as it refuses one in an environment value, and
        // a boot script is a program with a line per statement - so `sh -c
        // <script>` was an argument full of newlines, and every container started
        // that way was refused before it ran.
        for (const script of [commands.SESSION_BOOT, "set -eu\necho hello\n"]) {
            const argv = commands.bootArgv(script);
            expect(argv[0]).toBe("sh");
            expect(argv[1]).toBe("-c");
            for (const arg of argv) {
                // eslint-disable-next-line no-control-regex
                expect(/[\u0000-\u001f\u007f]/.test(arg), arg).toBe(false);
            }
        }
    });

    it("hands the script over unchanged, whatever was in it", () => {
        const argv = commands.bootArgv(commands.SESSION_BOOT);
        const encoded = /echo ([A-Za-z0-9+/=]+) \| base64 -d/.exec(argv[2] ?? "");
        expect(encoded).not.toBeNull();
        expect(Buffer.from(encoded![1]!, "base64").toString("utf8")).toBe(commands.SESSION_BOOT);
    });

    it("encodes to an alphabet the shell reads as plain text", () => {
        // No quoting is applied around it, so the encoding has to be the reason
        // that is safe rather than an oversight: base64 is letters, digits, plus,
        // slash and equals, and the shell reads none of those as syntax.
        const argv = commands.bootArgv(commands.SESSION_BOOT);
        expect(argv[2]).toMatch(/^echo [A-Za-z0-9+/=]+ \| base64 -d \| sh$/);
    });

    it("writes the hooks into the worktree, never into the machine's own home", () => {
        expect(commands.SESSION_SETUP).toContain('"$POLARIS_WORKDIR/.claude/settings.local.json"');
        expect(commands.SESSION_SETUP).not.toContain('"$HOME/.claude');
    });

    it("keeps the container alive after the agent inside it exits", () => {
        expect(commands.SESSION_BOOT.trimEnd().endsWith("exec tail -f /dev/null")).toBe(true);
    });

    it("starts the branch from the ref that was asked for, and from the default when none was", () => {
        expect(commands.SESSION_SETUP).toContain("$POLARIS_BASE_REF");
        expect(commands.SESSION_SETUP).toContain(
            'git clone --depth 50 --branch "$POLARIS_BASE_REF"'
        );
        // The other arm of the same `if`: no ref, no --branch.
        expect(commands.SESSION_SETUP).toContain("  git clone --depth 50 -c http.extraHeader");
    });

    it("puts the resolved Enigma settings on the machine, not only the install", () => {
        // One variable rather than two: installing Enigma and applying the
        // settings it resolved to are the same step, and splitting them is how
        // the config half came to run against a command the install had not left
        // on the PATH.
        expect(commands.SESSION_SETUP).toContain("$POLARIS_ENIGMA_SETUP");
    });
});

describe("the terminal the agent is started on", () => {
    // The one property everything else in a session rests on, and the one that
    // was quietly missing: a coding agent IS a full-screen terminal program, so
    // a session that starts it without a readable terminal has not started it at
    // all. It draws nothing, reports no session start, and the prompt sent to it
    // is echoed onto the screen as plain text by a line discipline with nobody
    // behind it. None of that looks like an error anywhere.
    const setupOf = (boot: string) =>
        boot.split("\n").find((line) => line.includes("tmux new-session")) ?? "";

    it("hands the setup to tmux without a pipe standing in for its terminal", () => {
        for (const boot of [commands.SESSION_BOOT, commands.SESSION_BOOT_FOR_HOST]) {
            const line = setupOf(boot);
            expect(line).toContain("tmux new-session -d");
            // `... | base64 -d | sh` is the shape that broke it: that shell's
            // standard input is the pipe, already at end of file, and every
            // process it starts inherits it - the agent included.
            expect(line).not.toMatch(/base64 -d \s*\|\s*sh/);
            expect(line).toContain("base64 -d)");
        }
    });

    it("decodes the setup through a substitution, so only the decoding reads a pipe", () => {
        const line = setupOf(commands.SESSION_BOOT);
        expect(line).toMatch(/sh -c 'eval "\$\(echo [A-Za-z0-9+/=]+ \| base64 -d\)"'/);
    });

    it("never asks a person on a machine they cannot see for a password", () => {
        // A real terminal is what makes this necessary. Given one, git asks for
        // a username the moment a credential is refused and then waits forever,
        // behind a screen that says the session is starting.
        expect(commands.SESSION_SETUP).toContain("GIT_TERMINAL_PROMPT=0");
        expect(commands.SESSION_SETUP.indexOf("GIT_TERMINAL_PROMPT=0")).toBeLessThan(
            commands.SESSION_SETUP.indexOf("git clone")
        );
    });
});

/**
 * What the first-run answers actually DO to a directory.
 *
 * Run rather than read. An earlier round of these grepped the generated program
 * for a line of its own source, which proves the line is there and nothing about
 * what it does - and the bug that cost three rounds of this was a correct-looking
 * write into a file nothing reads. So the program is executed against real
 * directories, and the files it leaves behind are the assertion.
 */
describe("the tool's own first-run wizard", () => {
    const claude = core.agentCliById("claude")!;

    /** Run the answers against a throwaway home and hand back what it wrote. */
    function answer(
        answers: readonly core.AgentFirstRunAnswer[],
        options: { readonly workdir?: string; readonly before?: Record<string, unknown> } = {}
    ) {
        const home = mkdtempSync(join(tmpdir(), "polaris-first-run-"));
        for (const [file, body] of Object.entries(options.before ?? {})) {
            const at = join(home, file);
            mkdirSync(dirname(at), { recursive: true });
            // A string is written as it stands, so a file that is not JSON at
            // all can be seeded the way the tool leaves one behind half-written.
            writeFileSync(at, typeof body === "string" ? body : JSON.stringify(body));
        }
        const list = join(home, "answers.json");
        writeFileSync(list, JSON.stringify(answers));
        const done = spawnSync(process.execPath, ["-e", commands.firstRunProgram(), list], {
            encoding: "utf8",
            env: { ...process.env, HOME: home, POLARIS_WORKDIR: options.workdir ?? "" }
        });
        expect(done.status, done.stderr).toBe(0);
        return {
            said: done.stdout.split("\n").filter((line) => line.startsWith("polaris:")),
            read: (file: string): Record<string, any> | null => {
                try {
                    return JSON.parse(readFileSync(join(home, file), "utf8")) as Record<
                        string,
                        any
                    >;
                } catch {
                    return null;
                }
            }
        };
    }

    it("answers what a fresh Claude Code asks, in the files it asks it from", () => {
        // Every key was read off an installed Claude Code. The flag is the one
        // its own startup tests before showing the wizard; the trust key is the
        // one its own message names as the alternative to the dialog; and the
        // colour scheme lives in the settings file rather than beside them,
        // which is exactly the sort of thing that cannot be guessed.
        const run = answer(claude.firstRun, { workdir: "/session/repo" });
        expect(run.read(".claude/.claude.json")).toEqual({
            hasCompletedOnboarding: true,
            projects: { "/session/repo": { hasTrustDialogAccepted: true } }
        });
        expect(run.read(".claude/settings.json")).toEqual({ theme: "dark" });
    });

    it("answers both questions in the configuration home as well as beside it", () => {
        // The one that was missing, and the reason the wizard came up anyway.
        // CLAUDE_CONFIG_DIR is Claude Code's configuration home and the config
        // file moves inside it; Enigma's launcher always sets that variable, and
        // Polaris starts these tools through Enigma whenever it is in the
        // session. The file beside it is what a bare launch reads, and Polaris
        // starts the tool both ways, so both are answered.
        //
        // The folder as much as the flag: dropping it from either file leaves a
        // bare launch in front of the dialog with nothing on screen to say why.
        const run = answer(claude.firstRun, { workdir: "/session/repo" });
        for (const file of [".claude.json", ".claude/.claude.json"]) {
            expect(run.read(file)?.hasCompletedOnboarding, file).toBe(true);
            expect(run.read(file)?.projects["/session/repo"], file).toEqual({
                hasTrustDialogAccepted: true
            });
        }
    });

    it("turns a No the agent gave itself into a Yes", () => {
        // The case every deployment that has already run a session is in. The
        // home outlives the session and the container's path is a constant, so
        // the first run left `false` under that exact path - chosen by an agent
        // hitting the highlighted option on a screen nobody could reach. Filling
        // in only what is missing would find an answer there, write nothing,
        // print nothing, and the dialog would come back with the terminal silent.
        //
        // The flag one screen earlier is the same answer by the same agent, so
        // it is asserted the same way and checked here in both files.
        const recorded = {
            hasCompletedOnboarding: false,
            projects: {
                "/session/repo": { hasTrustDialogAccepted: false, allowedTools: ["Bash"] }
            }
        };
        const run = answer(claude.firstRun, {
            workdir: "/session/repo",
            before: { ".claude/.claude.json": recorded, ".claude.json": recorded }
        });
        for (const file of [".claude/.claude.json", ".claude.json"]) {
            expect(run.read(file)?.hasCompletedOnboarding, file).toBe(true);
            const project = run.read(file)?.projects["/session/repo"];
            expect(project.hasTrustDialogAccepted, file).toBe(true);
            // And only those keys: whatever the tool recorded beside them stays.
            expect(project.allowedTools, file).toEqual(["Bash"]);
        }
    });

    it("writes the answer where the file holds something that is not a folder", () => {
        // `projects` present as `null` is a branch the fill rule walks away
        // from, which would be the answer never written and nothing said about
        // it - the same invisible failure, reached from a different state. An
        // answer that is Polaris's to give replaces it instead.
        const run = answer(claude.firstRun, {
            workdir: "/session/repo",
            before: { ".claude/.claude.json": { hasCompletedOnboarding: true, projects: null } }
        });
        expect(run.read(".claude/.claude.json")?.projects).toEqual({
            "/session/repo": { hasTrustDialogAccepted: true }
        });
        expect(run.said).toHaveLength(3);
    });

    it("treats a file it cannot read as one that was not there", () => {
        // A cache the tool owns, caught half-written. Refusing to start a
        // session over a byte out of place in it is the worse answer.
        const run = answer(claude.firstRun, {
            workdir: "/session/repo",
            before: { ".claude/.claude.json": "{not json" }
        });
        expect(run.read(".claude/.claude.json")).toEqual({
            hasCompletedOnboarding: true,
            projects: { "/session/repo": { hasTrustDialogAccepted: true } }
        });
    });

    it("never overrules a choice that is the person's to make", () => {
        // The other half of the same rule. Trust is Polaris's answer about a
        // folder Polaris made; a colour scheme is not Polaris's business at all.
        const run = answer(claude.firstRun, {
            workdir: "/session/repo",
            before: { ".claude/settings.json": { theme: "light" } }
        });
        expect(run.read(".claude/settings.json")).toEqual({ theme: "light" });
    });

    it("says nothing at all when there is nothing left to answer", () => {
        const answered = {
            hasCompletedOnboarding: true,
            projects: { "/session/repo": { hasTrustDialogAccepted: true } }
        };
        const run = answer(claude.firstRun, {
            workdir: "/session/repo",
            before: {
                ".claude/.claude.json": answered,
                ".claude.json": answered,
                ".claude/settings.json": { theme: "dark" }
            }
        });
        expect(run.said).toEqual([]);
    });

    it("names each file it wrote, and names it after writing it", () => {
        // The line exists because where a tool keeps its configuration MOVES,
        // and that failure leaves nothing to read. A line that could appear for
        // a file that was never written would be the same silence with a
        // reassurance on top.
        const run = answer(claude.firstRun, { workdir: "/session/repo" });
        expect(run.said).toHaveLength(3);
        for (const line of run.said) expect(line).toContain("answered its first run in");
    });

    it("skips the folder answer where there is no folder, and leaves nothing behind", () => {
        // The sign-in container has no worktree. The answer needing one is
        // skipped rather than written under a key still spelling the
        // placeholder - and no empty `projects` is left in the tool's own file.
        const run = answer(claude.firstRun);
        expect(run.read(".claude/.claude.json")).toEqual({ hasCompletedOnboarding: true });
    });

    it("adds a second worktree without taking the first one's answer away", () => {
        // Two sessions on one machine work in two folders, and the home they
        // share outlives both.
        const first = answer(claude.firstRun, { workdir: "/session/repo" });
        const run = answer(claude.firstRun, {
            workdir: "/home/node/workspace",
            before: { ".claude/.claude.json": first.read(".claude/.claude.json") ?? {} }
        });
        expect(Object.keys(run.read(".claude/.claude.json")?.projects ?? {}).sort()).toEqual([
            "/home/node/workspace",
            "/session/repo"
        ]);
    });

    it("names a file it could not write instead of abandoning the rest", () => {
        // One unwritable path is one tool asking its question; an abort there is
        // every question after it left unanswered.
        const home = mkdtempSync(join(tmpdir(), "polaris-first-run-"));
        writeFileSync(join(home, ".claude"), "not a directory");
        const list = join(home, "answers.json");
        writeFileSync(list, JSON.stringify(claude.firstRun));
        const done = spawnSync(process.execPath, ["-e", commands.firstRunProgram(), list], {
            encoding: "utf8",
            env: { ...process.env, HOME: home, POLARIS_WORKDIR: "/session/repo" }
        });
        expect(done.status).toBe(0);
        expect(done.stdout).toContain("could not write");
        // And the one that could be written still was.
        expect(JSON.parse(readFileSync(join(home, ".claude.json"), "utf8"))).toMatchObject({
            hasCompletedOnboarding: true
        });
    });

    it("says nothing about a tool nothing has been sourced for", () => {
        // The same rule as `credentials`: an empty list is an answer. A guessed
        // key is written, silently ignored, and leaves the session in front of
        // the wizard with nothing anywhere saying why.
        for (const cli of core.AGENT_CLIS) {
            if (cli.id === "claude") continue;
            expect(cli.firstRun, cli.id).toEqual([]);
        }
        expect(core.customAgentCli("whatever").firstRun).toEqual([]);
    });

    it("writes nothing at all when there is nothing to answer", () => {
        expect(commands.firstRunScript([])).toBe("");
    });

    it("quotes the answers rather than pasting them into a shell", () => {
        // Through the one quoting function, so an apostrophe in a value is a
        // character rather than the end of the string and the start of a
        // command. Nothing here comes from a person today, and that is exactly
        // why it is asserted: the next answer added to the catalogue will.
        const answers = [{ file: ".x.json", json: { note: "it's a value" } }];
        expect(commands.firstRunScript(answers)).toContain(shellQuote(JSON.stringify(answers)));
    });

    it("runs in the session before the agent does, and only where the home is Polaris's", () => {
        expect(commands.SESSION_SETUP).toContain(
            '[ -n "$POLARIS_FIRST_RUN" ] && [ -n "$POLARIS_HOME" ]'
        );
        expect(commands.SESSION_SETUP.indexOf("POLARIS_FIRST_RUN")).toBeLessThan(
            commands.SESSION_SETUP.indexOf("polaris: starting")
        );
        // After Enigma, which writes into one of the same files.
        expect(commands.SESSION_SETUP.indexOf("$POLARIS_ENIGMA_CONFIGURE")).toBeLessThan(
            commands.SESSION_SETUP.indexOf("$POLARIS_FIRST_RUN")
        );
    });

    it("is not left in the environment for the agent to read", () => {
        expect(commands.SESSION_SETUP).toContain("POLARIS_ENIGMA_CONFIGURE POLARIS_FIRST_RUN");
    });
});

describe("knowing there is an agent to type into", () => {
    it("asks the terminal and not only the flag", () => {
        const ready = commands.agentReadyCommand();
        expect(ready).toContain(commands.AGENT_READY_FLAG);
        // Canonical mode off is the terminal saying something is reading it as
        // keys rather than a shell buffering a line nobody will collect. It is
        // true of every one of these tools and of no shell, which is what a list
        // of process names could never be.
        expect(ready).toContain("-icanon");
        expect(ready).toContain("#{pane_tty}");
    });

    it("still answers for an agent whose terminal cannot be recognised", () => {
        // An operator's own command may be a script that reads a line at a time
        // and is perfectly ready. The flag going stale is the second answer, so
        // that session gets its prompt a minute in rather than never.
        expect(commands.agentReadyCommand()).toContain("-mmin +1");
    });

    it("is one line, because the host daemon refuses an argument with a newline in it", () => {
        expect(commands.agentReadyCommand()).not.toContain("\n");
    });

    it("quotes the session it asks about", () => {
        expect(commands.agentReadyCommand("polaris-agent")).toContain("'polaris-agent'");
    });
});

describe("the boot script for an enrolled server", () => {
    const host = commands.SESSION_SETUP;

    it("closes every conditional it opens, which filtering one script into another did not", () => {
        const lines = host.split("\n").map((line) => line.trim());
        expect(lines.filter((line) => line.startsWith("if ")).length).toBe(
            lines.filter((line) => line === "fi").length
        );
        expect(lines.filter((line) => line === "fi").length).toBeGreaterThan(0);
    });

    it("installs nothing on somebody else's machine", () => {
        // The setup is shared, so what differs is the boot around it: the
        // container installs tmux, the server is told when it is missing.
        expect(commands.SESSION_BOOT_FOR_HOST).not.toContain("apt-get");
        expect(commands.SESSION_BOOT).toContain("apt-get");
    });

    it("says what is missing rather than reaching for a package manager", () => {
        expect(commands.SESSION_BOOT_FOR_HOST).toContain("this machine has no tmux");
        expect(commands.SESSION_SETUP).toContain(
            "is not installed and could not be installed here"
        );
    });

    it("does not park a foreground process on it, and still leaves the agent running", () => {
        expect(commands.SESSION_BOOT_FOR_HOST).not.toContain("exec tail -f");
        // Detached, so the session outlives the SSH connection that started it -
        // which is the whole reason this shape works over SSH at all.
        expect(commands.SESSION_BOOT_FOR_HOST).toContain("tmux new-session -d");
    });

    it("clones and writes the hooks exactly as the container does", () => {
        expect(host).toContain('git checkout -b "$POLARIS_BRANCH"');
        expect(host).toContain('"$POLARIS_WORKDIR/.claude/settings.local.json"');
        expect(host).toContain("unset GIT_AUTH_HEADER");
    });
});

describe("the home a session keeps", () => {
    it("is one per account, and a name the daemon will take", () => {
        // The daemon resolves a bind source under its own volume root and
        // refuses anything that escapes it, so what goes in has to be a name.
        expect(commands.agentHomeSource("usr_abc123")).toBe("agent-homes/u-usr_abc123");
        expect(commands.agentHomeSource("../../etc")).toBe("agent-homes/u-etc");
        expect(commands.agentHomeSource("a/../b")).toBe("agent-homes/u-ab");
    });

    it("can never put an account in the machine everybody shares", () => {
        // The one mistake here that noticing later does not undo: an id that
        // happened to be the shared name would be one person's session opening
        // in the shared one, with everybody's logins in it.
        expect(commands.agentHomeSource("shared")).not.toBe(commands.SHARED_HOME_SOURCE);
        expect(commands.SHARED_HOME_SOURCE.startsWith("agent-homes/")).toBe(true);
    });

    it("stops rather than give two accounts the same home", () => {
        // An id that survives the strip as nothing would mount every session on
        // the same directory, which is one person's sign-in in another person's
        // terminal.
        expect(() => commands.agentHomeSource("...")).toThrow();
        expect(() => commands.agentHomeSource("")).toThrow();
    });

    it("installs the agent only when it is not already there", () => {
        // The whole point. The first session installs; every one after finds it
        // in the home that was kept and starts in seconds.
        expect(commands.SESSION_SETUP).toContain(
            '! command -v "$POLARIS_AGENT_BINARY" >/dev/null 2>&1'
        );
        expect(commands.SESSION_SETUP).toContain("! command -v enigma >/dev/null 2>&1");
    });

    it("points npm and the tools at that home rather than at root's", () => {
        // Where Enigma's ninety-three files went before: installed as root into
        // /root while the agent read /home/node and found nothing.
        expect(commands.SESSION_SETUP).toContain('NPM_CONFIG_PREFIX="$POLARIS_HOME/.npm-global"');
        expect(commands.SESSION_SETUP).toContain("export HOME NPM_CONFIG_PREFIX PATH");
    });

    it("preserves the environment when it drops privileges, which plain su does not", () => {
        // `su` without -p resets HOME and PATH, which would throw away the
        // persistent home and the npm prefix at the moment they matter.
        expect(commands.SESSION_SETUP).toContain('su -p "$POLARIS_RUNAS" -c "$1"');
    });

    it("hands the home over once rather than on every boot", () => {
        // A recursive chown over an npm tree every session is minutes of exactly
        // what this change exists to remove.
        expect(commands.SESSION_SETUP).toContain('[ ! -f "$POLARIS_HOME/.polaris-home" ]');
    });

    it("hands the working directory over once too, for the same reason", () => {
        // A workspace lives in that home and fills with node_modules and caches,
        // so a recursive walk of it before every session is the same wait
        // arriving by another door. Only a directory Polaris just made is walked.
        const boot = commands.SESSION_SETUP;
        expect(boot).toContain("POLARIS_WORKDIR_NEW=no");
        expect(boot).toContain(
            [
                '  if [ "$POLARIS_WORKDIR_NEW" = "yes" ]; then',
                '    chown -R "$POLARIS_RUNAS" "$POLARIS_WORKDIR" 2>/dev/null || true'
            ].join("\n")
        );
        // The recursive one appears once, and it is that one.
        expect(boot.match(/chown -R "\$POLARIS_RUNAS" "\$POLARIS_WORKDIR"/g)).toHaveLength(1);
    });

    it("still gives the agent the files Polaris wrote into a workspace it kept", () => {
        // Written as root on every boot, so skipping the walk must not leave the
        // hook script and the tool registration owned by somebody the agent is
        // not.
        expect(commands.SESSION_SETUP).toContain(
            'chown "$POLARIS_RUNAS" "$POLARIS_WORKDIR/.claude" "$POLARIS_WORKDIR/.claude/polaris-hook.sh" "$POLARIS_WORKDIR/.claude/settings.local.json" "$POLARIS_WORKDIR/.mcp.json"'
        );
    });

    it("marks a checkout as new, since it is a tree that was just cloned", () => {
        const boot = commands.SESSION_SETUP;
        expect(boot).toContain(
            ['git checkout -b "$POLARIS_BRANCH"', "POLARIS_WORKDIR_NEW=yes"].join("\n")
        );
    });

    it("says the sign-in is only asked for once, in the terminal doing the asking", () => {
        expect(commands.SESSION_SETUP).toContain("it only asks once");
        expect(commands.SESSION_SETUP).toContain('if [ -z "$POLARIS_SIGNED_IN" ]; then');
    });

    it("moves nothing into the home of somebody's own server", () => {
        // POLARIS_HOME is empty there, and every line that touches a home is
        // behind that test.
        expect(commands.SESSION_SETUP).toContain('if [ -n "$POLARIS_HOME" ]; then');
    });
});

describe("how far a session is through coming up", () => {
    it("says the first step is under way before anything has printed", () => {
        // The container is up and installing a terminal to run in. A readout
        // that showed nothing there would be the spinner this replaced.
        const steps = bootProgress("")!;
        expect(steps[0]?.state).toBe("doing");
        expect(steps.every((step) => step.state !== "done")).toBe(true);
    });

    it("moves as the boot says what it is doing", () => {
        const steps = bootProgress("polaris: fetching FJRG2007/polaris")!;
        expect(steps.find((step) => step.key === "workspace")?.state).toBe("done");
        expect(steps.find((step) => step.key === "fetch")?.state).toBe("doing");
        expect(steps.find((step) => step.key === "agent")?.state).toBe("waiting");
    });

    it("runs straight through the steps a second session does not pay", () => {
        // The whole point of the home that is kept: no install, so no wait. A
        // step that never printed is finished rather than stuck, because a later
        // one has spoken.
        const steps = bootProgress(
            ["polaris: fetching a/b", "polaris: claude is already installed here"].join("\n")
        )!;
        expect(steps.find((step) => step.key === "enigma")?.state).toBe("done");
        expect(steps.find((step) => step.key === "agent")?.state).toBe("doing");
    });

    it("stops once the agent has the terminal", () => {
        // Past that point a progress readout is clutter over the thing somebody
        // actually came to read.
        expect(bootProgress("polaris: starting claude")).toBeNull();
    });

    it("matches lines this file actually prints", () => {
        // The failure it guards is silent: reword an echo and the bar stops
        // moving, with nothing anywhere saying why.
        const boot = commands.SESSION_SETUP;
        for (const mark of [
            "polaris: preparing this account",
            "polaris: fetching ",
            "polaris: installing Enigma",
            "This happens once",
            "is already installed here",
            "polaris: starting "
        ]) {
            expect(boot, mark).toContain(mark);
        }
    });
});

describe("shellQuote", () => {
    it("makes a command substitution inert", () => {
        expect(shellQuote("$(rm -rf /)")).toBe("'$(rm -rf /)'");
    });

    it("survives a quote of its own", () => {
        expect(shellQuote("it's")).toBe("'it'\\''s'");
    });
});

describe("steering a session", () => {
    it("pastes rather than types, so a newline in a prompt is text", () => {
        const command = commands.pastePromptCommand("line one\nline two");
        expect(command).toContain("paste-buffer -p");
        expect(command).toContain("line one\nline two");
    });

    it("quotes the prompt and makes its escapes inert, which are two different attacks", () => {
        const command = commands.pastePromptCommand(`'; rm -rf / #${ESC}[201~`);
        expect(command).not.toContain(ESC);
        expect(command).toContain("'\\''");
    });

    it("submits separately, because the paste has to land first", () => {
        expect(commands.submitCommand()).toContain("send-keys");
        expect(commands.submitCommand()).toContain("Enter");
        expect(commands.submitDelayMs("x")).toBeGreaterThanOrEqual(500);
        expect(commands.submitDelayMs("x".repeat(40_960))).toBeGreaterThan(
            commands.submitDelayMs("x")
        );
    });

    it("asks whether there is a terminal to type into before deciding one is missing", () => {
        expect(commands.aliveCommand()).toContain("has-session");
        expect(commands.aliveCommand()).toContain("polaris-agent");
    });

    it("interrupts with Escape, not with the key that would quit", () => {
        expect(commands.interruptCommand()).toContain("Escape");
        expect(commands.interruptCommand()).not.toContain("C-c");
    });
});

describe("the hook script", () => {
    it("never puts the token on a command line an argument list would expose", () => {
        const script = hookScript(
            "https://polaris.example/api/agents/sessions/s1/events",
            "tok_abc"
        );
        expect(script).toContain("'Authorization: Bearer tok_abc'");
        expect(script).toContain("--data-binary @-");
    });

    it("always exits 0, so an unreachable Polaris never changes what an agent does", () => {
        expect(hookScript("https://x/y", "t").trimEnd().endsWith("exit 0")).toBe(true);
    });

    it("gives up quickly rather than holding the agent up", () => {
        expect(hookScript("https://x/y", "t")).toContain("-m 4");
    });
});

describe("claudeHookSettings", () => {
    it("registers the event that says the agent is blocked on a person", () => {
        const settings = claudeHookSettings("/w/.claude/polaris-hook.sh") as {
            hooks: Record<string, unknown[]>;
        };
        expect(Object.keys(settings.hooks)).toContain("Notification");
        expect(Object.keys(settings.hooks)).toContain("Stop");
    });

    it("watches every tool rather than a chosen few", () => {
        const settings = claudeHookSettings("/w/hook.sh") as {
            hooks: Record<string, { matcher?: string }[]>;
        };
        expect(settings.hooks.PreToolUse?.[0]?.matcher).toBe("*");
    });
});

describe("normalizeHookEvent", () => {
    it("says what a tool call is doing in one line", () => {
        expect(
            normalizeHookEvent({
                hook_event_name: "PreToolUse",
                tool_name: "Bash",
                tool_input: { command: "npm test" }
            })
        ).toEqual({ kind: "tool.start", detail: "Bash: npm test", subject: "Bash" });
    });

    it("falls back to the tool's name for one it does not know the shape of", () => {
        expect(
            normalizeHookEvent({
                hook_event_name: "PreToolUse",
                tool_name: "SomeNewTool",
                tool_input: { a: 1 }
            })
        ).toEqual({ kind: "tool.start", detail: "SomeNewTool", subject: "SomeNewTool" });
    });

    it("maps the end of a turn and the moment it needs somebody to different states", () => {
        expect(normalizeHookEvent({ hook_event_name: "Stop" })?.kind).toBe("turn.end");
        expect(
            normalizeHookEvent({ hook_event_name: "Notification", message: "Needs permission" })
        ).toEqual({
            kind: "question",
            detail: "Needs permission",
            subject: ""
        });
    });

    it("says nothing about an event nobody has mapped", () => {
        expect(normalizeHookEvent({ hook_event_name: "SomethingNew" })).toBeNull();
        expect(normalizeHookEvent("not an object")).toBeNull();
        expect(normalizeHookEvent(null)).toBeNull();
    });

    it("does not let a wall of output become the line on a screen", () => {
        const detail = normalizeHookEvent({
            hook_event_name: "PreToolUse",
            tool_name: "Bash",
            tool_input: { command: "x".repeat(5000) }
        })?.detail;
        expect(detail?.length).toBeLessThan(200);
    });
});

describe("hookEventFailed", () => {
    it("tells a tool that failed from one that worked", () => {
        expect(hookEventFailed({ tool_response: { success: false } })).toBe(true);
        expect(hookEventFailed({ tool_response: { error: "no such file" } })).toBe(true);
        expect(hookEventFailed({ tool_response: { output: "fine" } })).toBe(false);
        expect(hookEventFailed({})).toBe(false);
    });
});

describe("finding the address a login printed", () => {
    it("picks the first http(s) address on the screen", () => {
        const screen = [
            " Browser didn't open? Use the url below to sign in (c to copy)",
            "",
            "https://claude.com/cai/oauth/authorize?code=true&client_id=abc&scope=user%3Ainference",
            "",
            " Paste code here if prompted >"
        ].join("\n");
        expect(commands.firstUrlIn(screen)).toBe(
            "https://claude.com/cai/oauth/authorize?code=true&client_id=abc&scope=user%3Ainference"
        );
    });

    it("is a rule rather than a pattern per vendor", () => {
        // The point of the rule: a tool nobody has added yet prints a URL and
        // waits for a code, exactly like the ones that have been.
        expect(commands.firstUrlIn("go to http://localhost:1455/auth to continue")).toBe(
            "http://localhost:1455/auth"
        );
    });

    it("leaves the punctuation a sentence put around it", () => {
        // A bracket or a full stop swept into the address is a link that 404s in
        // a way nobody looks at twice.
        expect(commands.firstUrlIn("open (https://example.com/a/b).")).toBe(
            "https://example.com/a/b"
        );
        expect(commands.firstUrlIn("see https://example.com/x, then paste")).toBe(
            "https://example.com/x"
        );
    });

    it("says nothing when there is nothing to say", () => {
        expect(commands.firstUrlIn("")).toBeNull();
        expect(commands.firstUrlIn("Installing @anthropic-ai/claude-code")).toBeNull();
        // Not a scheme anybody should be sent to.
        expect(commands.firstUrlIn("file:///etc/passwd")).toBeNull();
    });

    it("reads the joined capture, which is the only one an address survives", () => {
        // A terminal breaks a line at its own width, so unjoined this arrives in
        // pieces with the break inside a query parameter.
        expect(commands.captureJoinedCommand()).toContain("-J");
        expect(commands.captureCommand()).not.toContain("-J");
    });

    it("asks for a terminal a dialog can show without a horizontal scrollbar", () => {
        expect(commands.SIGNIN_COLS).toBeLessThan(commands.TMUX_COLS);
        // Eighty is what every one of these tools falls back to, so what it draws
        // at this size is a layout its vendor tested.
        expect(commands.SIGNIN_COLS).toBe(80);
    });
});
