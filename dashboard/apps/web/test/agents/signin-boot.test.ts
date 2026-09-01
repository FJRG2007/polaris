/**
 * The container Polaris starts to sign an agent in.
 *
 * Assertable on its own, which is the only way any of it can be checked here:
 * this machine has no Docker, so nothing below has ever run. What CAN be pinned
 * down is that the script is a fixed string with no value interpolated into it,
 * and that every variable it reads is one the runtime actually sets - the two
 * mistakes that turn a boot script into either a shell injection or a container
 * that comes up and immediately exits on an unbound name.
 *
 * It is the same discipline the session boot script is held to next door, for
 * the same reason and with one extra edge: a session is started by somebody with
 * `agents.manage`, and this is started by anybody with an account. It is the only
 * place in Polaris where that is true, so what it does with what it is given
 * matters more here than there.
 */

import * as core from "@polaris/core";
import { describe, expect, it } from "vitest";
import { AGENT_ACCOUNT_SETUP } from "@/lib/agents/session-commands";
import {
    SIGNIN_BOOT,
    canAssistSignin,
    assistedSignins,
    signinFirstRun,
    whoamiScript
} from "@/lib/agents/signin-runtime";

describe("the sign-in boot script", () => {
    it("interpolates nothing", () => {
        // A template hole here would be a value from an account reaching a shell
        // running as root in a container.
        expect(SIGNIN_BOOT).not.toMatch(/\$\{/);
    });

    it("reads every value it needs from the environment", () => {
        for (const name of [
            "POLARIS_TMUX",
            "POLARIS_COLS",
            "POLARIS_ROWS",
            "POLARIS_INSTALL",
            "POLARIS_LOGIN"
        ]) {
            expect(SIGNIN_BOOT).toContain(`$${name}`);
        }
    });

    it("quotes every one of them", () => {
        // An unquoted expansion is a value from the catalogue being re-split by
        // the shell, which is how a command with a space in it becomes two.
        for (const name of ["POLARIS_TMUX", "POLARIS_INSTALL", "POLARIS_LOGIN"]) {
            expect(SIGNIN_BOOT).toContain(`"$${name}"`);
        }
    });

    it("stops rather than carry on without tmux", () => {
        // Without it there is no terminal to relay, so the dialog would poll an
        // empty screen forever with nothing saying why.
        expect(SIGNIN_BOOT).toContain("polaris: this machine has no tmux");
        expect(SIGNIN_BOOT).toContain("exit 1");
    });

    it("parks instead of exiting", () => {
        // The container has to outlive the login command: a finished login still
        // has its result on the screen, which is the entire point.
        expect(SIGNIN_BOOT.trimEnd().endsWith("exec tail -f /dev/null")).toBe(true);
    });

    it("carries no credential in", () => {
        // Nothing of anybody's is handed to this container. The one thing
        // mounted is the person's own home, which is where the login is meant
        // to land - and the only thing that leaves here, by already being in it.
        expect(SIGNIN_BOOT).not.toContain("GIT_AUTH_HEADER");
        expect(SIGNIN_BOOT).not.toContain("GH_TOKEN");
        expect(SIGNIN_BOOT).not.toContain("ANTHROPIC");
    });

    it("signs in as the account the sessions run as, into the home they read", () => {
        // The failure this prevents is quiet and total: a login written into
        // root's home by the dialog and looked for in the agent's home by every
        // session afterwards is a dialog that says it worked and a tool that
        // asks again.
        expect(SIGNIN_BOOT).toContain("$POLARIS_HOME");
        expect(SIGNIN_BOOT).toContain("$POLARIS_RUNAS");
        expect(SIGNIN_BOOT).toContain("su -p");
    });

    it("keeps the screen after the login command finishes", () => {
        // It prints its result and exits, and the window used to go with it -
        // taking the one line somebody was there to read.
        expect(SIGNIN_BOOT).toContain("exec sh");
    });
});

describe("which sign-ins Polaris can run for somebody", () => {
    it("knows the Claude subscription token, which is the one that needed it", () => {
        expect(canAssistSignin("CLAUDE_CODE_OAUTH_TOKEN")).toBe(true);
    });

    it("says no to anything it holds no login command for", () => {
        // An API key is copied off a page; there is no login to walk anybody
        // through, and claiming otherwise would open a container for nothing.
        expect(canAssistSignin("ANTHROPIC_API_KEY")).toBe(false);
        expect(canAssistSignin("OPENAI_API_KEY")).toBe(false);
        expect(canAssistSignin("")).toBe(false);
    });

    it("only offers ones that are actually asked for somewhere", () => {
        // A login command for a credential nothing needs is a button that opens
        // a container to produce a value no session reads.
        for (const signin of assistedSignins()) {
            expect(canAssistSignin(signin.env), signin.env).toBe(true);
            expect(signin.serves.length, signin.env).toBeGreaterThan(0);
        }
    });
});

describe("the first-run answers the sign-in container writes", () => {
    it("are the ones belonging to the tool whose login this is", () => {
        const claude = core.AGENT_CLIS.find((cli) => cli.id === "claude");
        expect(signinFirstRun("CLAUDE_CODE_OAUTH_TOKEN")).toEqual(claude?.firstRun);
        expect(signinFirstRun("CLAUDE_CODE_OAUTH_TOKEN").length).toBeGreaterThan(0);
    });

    it("are nothing at all for a credential no login command claims", () => {
        // An environment variable belongs to as many tools as declare it -
        // ANTHROPIC_API_KEY to seven of them - so resolving the answers through
        // the credential wrote whichever entry happened to come first in the
        // catalogue into somebody else's home.
        expect(signinFirstRun("ANTHROPIC_API_KEY")).toEqual([]);
        expect(signinFirstRun("OPENAI_API_KEY")).toEqual([]);
        expect(signinFirstRun("")).toEqual([]);
    });

    it("reach the container, which is the same home a session prepares", () => {
        // Whichever of the two gets there first has to answer the wizard: a
        // four-line dialog is a worse place to meet a full-screen colour picker
        // than a session's terminal is.
        expect(SIGNIN_BOOT).toContain("$POLARIS_FIRST_RUN");
    });
});

describe("asking the container who just signed in", () => {
    const script = whoamiScript("claude auth status --json");

    it("asks as the account that did the login, not as the root docker exec lands on", () => {
        // The tool is installed into the agent's npm prefix and the credential
        // was written into the agent's home, so root has neither: asked there it
        // is a missing command whose output is not JSON, which is the identity
        // silently lost on every credential this stores.
        expect(script).toContain("as_agent 'claude auth status --json'");
        expect(script).toContain('su -p "$POLARIS_RUNAS" -c "$1"');
    });

    it("gets that account from the same builder the boot did", () => {
        // One definition of who the agent is and where its home is. Two would
        // drift, and the way that shows up is a login written in one home and
        // read from another.
        expect(script).toContain(AGENT_ACCOUNT_SETUP);
        expect(SIGNIN_BOOT).toContain(AGENT_ACCOUNT_SETUP);
    });

    it("throws the preamble's own output away, since the answer has to be JSON", () => {
        // One line of setup chatter ahead of it loses the identity just as
        // surely as no answer at all.
        expect(script).toContain("} >/dev/null 2>&1");
        expect(script.indexOf("} >/dev/null 2>&1")).toBeLessThan(script.indexOf("as_agent '"));
    });

    it("quotes the command, so a quote in one closes nothing", () => {
        // It goes through `as_agent`, which hands it to `su -c` - a second shell.
        // A single quote that got there unescaped would end the quoting and make
        // the rest of the line something that shell runs.
        expect(whoamiScript("say 'hi'")).toContain("as_agent 'say '\\''hi'\\'''");
    });
});
