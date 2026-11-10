/**
 * Reading a sign-in's terminal.
 *
 * The sample is what a real `copilot login --device-code` left on the dialog:
 * tmux complaining while it was still being installed, a redrawn row glued to
 * the copy that replaced it, a shorter line written over a longer one, and the
 * job-control notice of the shell that used to be started after the login.
 */

import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { LOGIN_COMMANDS, SIGNIN_BOOT, signinCaptureCommand } from "@/lib/agents/signin-runtime";
import {
    SIGNIN_EXIT_MARKER,
    SIGNIN_READY_FILE,
    cleanSigninScreen,
    deviceCodeIn,
    isContainerNoise,
    pendingAutoAnswer,
    readSigninScreen,
    signedInAsIn
} from "@/lib/agents/signin-screen";

const COPILOT_SAMPLE = [
    "sh: 1: tmux: not found",
    "error connecting to /tmp/tmux-0/default (No such file or directory)",
    "To authenticate, visit https://github.com/login/de To authenticate, visit https://github.com/login/device and enter code 37FB-F903",
    "Waiting for authorization...",
    "Failed to open browser. Please visit https://github.com/login/device and enter the code 37FB-F903 manually.ice and enter code 37FB-F903",
    "System keychain unavailable. Store token in plaintext config file? (y/N) y",
    "Signed in successfully as FJRG2007.",
    "sh: 0: can't access tty; job control turned off",
    "$ "
].join("\n");

describe("cleaning the screen", () => {
    it("puts the Copilot sample back to the lines it printed", () => {
        expect(cleanSigninScreen(COPILOT_SAMPLE).screen).toBe(
            [
                "To authenticate, visit https://github.com/login/device and enter code 37FB-F903",
                "Waiting for authorization...",
                "Failed to open browser. Please visit https://github.com/login/device and enter the code 37FB-F903 manually.",
                "System keychain unavailable. Store token in plaintext config file? (y/N) y",
                "Signed in successfully as FJRG2007."
            ].join("\n")
        );
    });

    it("finds the whole address, not the fragment the redraw left first", () => {
        // Read raw, the first address on that screen is ".../login/de".
        expect(readSigninScreen(COPILOT_SAMPLE).url).toBe("https://github.com/login/device");
    });

    it("leaves ordinary lines that share an ending alone", () => {
        const screen = ["Press Enter to continue", "Saved. Press Enter to continue"].join("\n");
        expect(cleanSigninScreen(screen).screen).toBe(screen);
        // A residue is glued on; a sentence that merely ends the same is not.
        const later = ["the code is ready now", "and then the code is ready now"].join("\n");
        expect(cleanSigninScreen(later).screen).toBe(later);
    });

    it("reads the exit status and does not show it", () => {
        const clean = cleanSigninScreen(`Signed in.\n\n${SIGNIN_EXIT_MARKER} 0\n\n\n`);
        expect(clean).toEqual({ screen: "Signed in.", exitCode: 0 });
        expect(cleanSigninScreen(`boom\n${SIGNIN_EXIT_MARKER} 1`).exitCode).toBe(1);
        expect(cleanSigninScreen("still going").exitCode).toBeNull();
    });
});

describe("telling the machine getting ready from the login", () => {
    it("treats tmux's own complaints as nothing on the screen yet", () => {
        for (const line of [
            "sh: 1: tmux: not found",
            "no server running on /tmp/tmux-0/default",
            "error connecting to /tmp/tmux-0/default (No such file or directory)",
            "can't find session: polaris-signin"
        ]) {
            expect(isContainerNoise(line)).toBe(true);
            expect(readSigninScreen(line).screen).toBe("");
        }
        expect(isContainerNoise("Waiting for authorization...")).toBe(false);
    });

    it("does not read the pane before the boot says the session exists", () => {
        const command = signinCaptureCommand();
        expect(command.startsWith(`[ -f ${SIGNIN_READY_FILE} ] || exit 0;`)).toBe(true);
        expect(command).toContain("2>/dev/null");
        expect(command).toContain("-J");
    });

    it("prints nothing at all through a real shell while the file is missing", () => {
        // The guard is shell, so it is run by one: no tmux on this machine and
        // no ready file, which is exactly the container's first minute.
        const result = spawnSync("sh", ["-c", signinCaptureCommand()], { encoding: "utf8" });
        expect(result.status).toBe(0);
        expect(`${result.stdout}${result.stderr}`).toBe("");
    });
});

describe("the boot's run line", () => {
    it("expands to the login, its status, and a silent park", () => {
        const lines = SIGNIN_BOOT.split("\n");
        const from = lines.findIndex((line) => line.startsWith("POLARIS_RUN='"));
        const to = lines.findIndex((line) => line.startsWith('POLARIS_RUN="$POLARIS_RUN;'));
        const script = ["POLARIS_AS_ROOT=no", ...lines.slice(from, to + 1), 'printf %s "$POLARIS_RUN"'];
        const result = spawnSync("sh", ["-c", script.join("\n")], { encoding: "utf8" });
        expect(result.stdout).toBe(
            `sh /tmp/polaris-login.sh; polaris_status=$?; echo; echo ${SIGNIN_EXIT_MARKER} $polaris_status; exec tail -f /dev/null`
        );
    });

    it("reports the status the login command really ended with", () => {
        // The same line, with the login swapped for one that fails and the park
        // for an exit, so it can run to the end here.
        const line = SIGNIN_BOOT.split("\n").find((one) => one.startsWith('POLARIS_RUN="$POLARIS_RUN;'))!;
        const script = [
            "POLARIS_RUN='sh -c \"exit 3\"'",
            line.replace("exec tail -f /dev/null", "true"),
            'sh -c "$POLARIS_RUN"'
        ];
        const result = spawnSync("sh", ["-c", script.join("\n")], { encoding: "utf8" });
        expect(cleanSigninScreen(result.stdout).exitCode).toBe(3);
    });
});

describe("the device code", () => {
    it("is the code GitHub printed", () => {
        expect(deviceCodeIn(cleanSigninScreen(COPILOT_SAMPLE).screen)).toBe("37FB-F903");
    });

    it("is found on the line under one that announces it", () => {
        const screen = [
            "1. Open this link in your browser and sign in to your account",
            "   https://auth.example.com/device",
            "2. Enter this one-time code (expires in 15 minutes)",
            "   AB12-CD345"
        ].join("\n");
        expect(deviceCodeIn(screen)).toBe("AB12-CD345");
    });

    it("is never something that only looks like one", () => {
        expect(deviceCodeIn("Installing ABCD-1234 build 2026-1110")).toBeNull();
        expect(deviceCodeIn("")).toBeNull();
        // Lower case and longer runs are not the shape.
        expect(deviceCodeIn("enter code abcd-efgh")).toBeNull();
        expect(deviceCodeIn("enter code ABCDEFGHI-ABCD")).toBeNull();
    });

    it("follows a code that was replaced", () => {
        expect(deviceCodeIn("enter code AAAA-1111\nexpired\nenter code BBBB-2222")).toBe("BBBB-2222");
    });
});

describe("knowing the login worked", () => {
    it("reads who signed in", () => {
        expect(signedInAsIn("Signed in successfully as FJRG2007.")).toBe("FJRG2007");
        expect(signedInAsIn("Waiting for authorization...")).toBeNull();
    });

    it("counts a success line or a clean exit as finished, and nothing else", () => {
        expect(readSigninScreen(COPILOT_SAMPLE).finished).toBe(true);
        expect(readSigninScreen(`done\n${SIGNIN_EXIT_MARKER} 0`).finished).toBe(true);
        expect(readSigninScreen(`failed\n${SIGNIN_EXIT_MARKER} 1`).finished).toBe(false);
        expect(readSigninScreen("Waiting for authorization...").finished).toBe(false);
    });
});

describe("the plaintext-storage question", () => {
    const answers = LOGIN_COMMANDS.COPILOT_DEVICE_AUTH!.autoAnswers!;

    it("is answered yes while it is waiting", () => {
        const screen = "System keychain unavailable. Store token in plaintext config file? (y/N) ";
        expect(pendingAutoAnswer(screen, answers)).toBe("y");
        expect(pendingAutoAnswer(`${screen}\n\n`, answers)).toBe("y");
    });

    it("is not answered again once the answer is on the screen", () => {
        expect(pendingAutoAnswer("Store token in plaintext config file? (y/N) y", answers)).toBeNull();
        expect(pendingAutoAnswer(cleanSigninScreen(COPILOT_SAMPLE).screen, answers)).toBeNull();
    });

    it("is asked only of the login that asks it", () => {
        expect(LOGIN_COMMANDS.CLAUDE_CODE_OAUTH_TOKEN!.autoAnswers).toBeUndefined();
        expect(pendingAutoAnswer("Store token in plaintext config file? (y/N)", [])).toBeNull();
    });
});

describe("which logins are device-code ones", () => {
    it("are the two that print an address and a code", () => {
        expect(LOGIN_COMMANDS.COPILOT_DEVICE_AUTH!.flow).toBe("device");
        expect(LOGIN_COMMANDS.CODEX_CHATGPT_AUTH!.flow).toBe("device");
        expect(LOGIN_COMMANDS.GEMINI_GOOGLE_AUTH!.flow).toBe("paste");
        expect(LOGIN_COMMANDS.CLAUDE_CODE_OAUTH_TOKEN!.flow).toBe("paste");
    });
});
