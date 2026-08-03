/**
 * The macOS branch of the enrollment script, actually run.
 *
 * This is the branch the whole SSH preflight was written for - a Mac ships with
 * Remote Login off, so the login got installed and then nothing answered - and it
 * is the one branch that could never be executed while it was being written, for
 * want of a Mac. Reading it for the shape of its `if`s is how it acquired a stock
 * Mac that enrolled before the change and refused after it.
 *
 * So the branch is sliced out of the generated script and run under a real POSIX
 * shell against a simulated Mac: `systemsetup`, `dscl` and `dseditgroup` are stubs
 * that hold state, and each test sets what kind of Mac they describe. Nothing is
 * asserted about the script's text here - only about where the machine ended up,
 * which is the thing the operator lives with.
 *
 * `die` is the script's own, with `curl` stubbed to record what it posts, so the
 * refusal code these paths report is the one Polaris would actually receive.
 */

import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { execFileSync } from "node:child_process";
import { enrollmentScript } from "../../src/lib/enrollment-script";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";

const script = enrollmentScript({
    baseUrl: "https://polaris.example.com",
    token: "tok",
    username: "polaris",
    publicKey: "ssh-ed25519 AAAAC3Nz polaris-server"
});

/** The `die` the script really uses, so a refusal here is reported the way one is. */
const dieHelper = (() => {
    const start = script.indexOf("die() {");
    return script.slice(start, script.indexOf("\n}", start) + 2);
})();

/** The macOS half of the platform split, without the `if` that selects it. */
const darwinBranch = (() => {
    const opening = 'if [ "$PLATFORM" = "darwin" ]; then\n    read_remote_login() {';
    const start = script.indexOf(opening);
    const end = script.indexOf("\nelse\n    SSH_PROBE=none");
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    return script.slice(start + 'if [ "$PLATFORM" = "darwin" ]; then\n'.length, end);
})();

const HARNESS = `set -eu
POLARIS_URL='https://polaris.example.com'
POLARIS_TOKEN='tok'
POLARIS_USER='polaris'
POLARIS_RETRY_HINT='run it again'
SSH_PORT=22

say() { echo "say: $1"; }

${dieHelper}

${darwinBranch}

echo "reached: the claim"
`;

const STUBS: Record<string, string> = {
    // Holds the toggle in a file, the way the machine holds it: the script reads it
    // back rather than trusting the exit code, so a stub that only echoed would
    // never exercise that.
    systemsetup: `#!/bin/sh
case "\$1" in
    -getremotelogin)
        if [ -f "\$STATE/on" ]; then echo "Remote Login: On"; else echo "Remote Login: Off"; fi ;;
    -setremotelogin)
        shift
        if [ "\${1:-}" = "-f" ]; then shift; fi
        case "\${SYSTEMSETUP_MODE:-ok}" in
            refuse-enable) if [ "\$1" = "on" ]; then exit 1; fi ;;
            refuse-disable) if [ "\$1" = "off" ]; then exit 1; fi ;;
        esac
        case "\$1" in
            on) : > "\$STATE/on" ;;
            off) rm -f "\$STATE/on" ;;
        esac ;;
esac
exit 0
`,
    // Only the group listing matters here; every other dscl call in the script runs
    // before this branch.
    dscl: `#!/bin/sh
case "\$*" in
    *"-list /Groups"*)
        case "\${GROUPS_MODE:-stock}" in
            fail) exit 1 ;;
            empty) exit 0 ;;
            existing) printf 'staff\\ncom.apple.access_ssh\\nwheel\\n' ;;
            *) printf 'staff\\ncom.apple.access_screensharing\\nwheel\\n' ;;
        esac ;;
esac
exit 0
`,
    dseditgroup: `#!/bin/sh
if [ "\${DSEDIT_MODE:-ok}" = "missing" ]; then exit 127; fi
case "\$2" in
    create)
        : > "\$STATE/group"
        exit 0 ;;
    delete)
        rm -f "\$STATE/group" "\$STATE/member" "\$STATE/everyone"
        exit 0 ;;
    edit)
        case "\$*" in
            *"-d everyone"*) rm -f "\$STATE/everyone" ;;
            *"-a polaris"*) : > "\$STATE/member" ;;
        esac
        exit 0 ;;
    checkmember)
        if [ "\${DSEDIT_MODE:-ok}" = "unreadable" ]; then echo "could not be read"; exit 1; fi
        case "\$*" in
            *"-m polaris"*)
                if [ -f "\$STATE/member" ]; then echo "yes polaris is a member of com.apple.access_ssh"; else echo "no"; fi ;;
            *"-m everyone"*)
                if [ -f "\$STATE/everyone" ]; then echo "yes"; else echo "no everyone is not a member"; fi ;;
        esac
        exit 0 ;;
esac
exit 0
`,
    // What die reports, kept rather than sent.
    curl: `#!/bin/sh
cat >> "\$STATE/refused"
exit 0
`
};

/** A machine that has never had Remote Login on, which is what a Mac ships as. */
interface Mac {
    /** Whether Remote Login is already on. */
    readonly remoteLogin?: boolean;
    /** Whether the machine already carries an SSH access list, and whether it can
     *  even be asked: `fail` is a directory service that would not answer. */
    readonly groups?: "stock" | "existing" | "fail" | "empty";
    /** Whether the group edits can be read back afterwards, and whether the tool is
     *  even resolvable under the sudo PATH. */
    readonly dseditgroup?: "ok" | "unreadable" | "missing";
    /** Whether the toggle refuses, the way it does without Full Disk Access. */
    readonly systemsetup?: "ok" | "refuse-enable" | "refuse-disable";
    /** Whether the machine already lets every account in over SSH. */
    readonly everyone?: boolean;
}

interface Outcome {
    readonly status: number;
    readonly stdout: string;
    readonly stderr: string;
    /** Whether Remote Login is on when the script is done with the machine. */
    readonly remoteLoginOn: boolean;
    /** Whether the SSH access list exists when the script is done with it. */
    readonly accessGroup: boolean;
    /** The codes the machine reported to Polaris on its way out. */
    readonly refused: string[];
}

let sandbox = "";

beforeEach(() => {
    sandbox = mkdtempSync(join(tmpdir(), "polaris-enroll-"));
});

afterEach(() => {
    rmSync(sandbox, { recursive: true, force: true });
});

function run(mac: Mac = {}): Outcome {
    const bin = join(sandbox, "bin");
    const state = join(sandbox, "state");
    mkdirSync(bin);
    mkdirSync(state);
    for (const [name, body] of Object.entries(STUBS)) {
        const path = join(bin, name);
        writeFileSync(path, body);
        chmodSync(path, 0o755);
    }
    if (mac.remoteLogin) writeFileSync(join(state, "on"), "");
    if (mac.groups === "existing") writeFileSync(join(state, "group"), "");
    if (mac.everyone) writeFileSync(join(state, "everyone"), "");

    const harness = join(sandbox, "darwin.sh");
    writeFileSync(harness, HARNESS);

    let status = 0;
    let stdout = "";
    let stderr = "";
    try {
        stdout = execFileSync("sh", [harness], {
            encoding: "utf8",
            stdio: ["ignore", "pipe", "pipe"],
            env: {
                ...process.env,
                PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
                STATE: state,
                GROUPS_MODE: mac.groups ?? "stock",
                DSEDIT_MODE: mac.dseditgroup ?? "ok",
                SYSTEMSETUP_MODE: mac.systemsetup ?? "ok"
            }
        });
    } catch (error) {
        const failure = error as { status?: number; stdout?: string; stderr?: string };
        status = failure.status ?? 1;
        stdout = failure.stdout ?? "";
        stderr = failure.stderr ?? "";
    }
    const read = (name: string): string | null => {
        try {
            return readFileSync(join(state, name), "utf8");
        } catch {
            return null;
        }
    };
    return {
        status,
        stdout,
        stderr,
        remoteLoginOn: read("on") !== null,
        accessGroup: read("group") !== null,
        refused: [...(read("refused") ?? "").matchAll(/"reason":"([a-z-]+)"/g)].map(
            (match) => match[1]
        )
    };
}

// Nothing below is worth running if the shell is not there, and a silent skip on
// the machine that runs the suite would be worse than saying so.
const shell = (() => {
    try {
        execFileSync("sh", ["-c", "exit 0"], { stdio: "ignore" });
        return true;
    } catch {
        return false;
    }
})();

describe.runIf(shell)("the macOS branch, run against a simulated Mac", () => {
    // The machine this whole change exists for: Remote Login off, no access list,
    // nothing listening. It has to come out the other side enrolled - a refusal
    // here is the feature failing on the only box it was written for.
    it("enrolls a stock Mac, with SSH limited to the Polaris login", () => {
        const outcome = run();
        expect(outcome.status).toBe(0);
        expect(outcome.refused).toEqual([]);
        expect(outcome.stdout).toContain(
            "say: turned Remote Login on, limited to the 'polaris' login"
        );
        expect(outcome.stdout).toContain("reached: the claim");
        // And the machine is left the way that sentence describes it.
        expect(outcome.remoteLoginOn).toBe(true);
        expect(outcome.accessGroup).toBe(true);
    });

    // A Mac can have the toggle off and still carry the list its operator built
    // before switching it off. Narrowing that one withdraws access somebody else
    // granted, so it is added to and left alone.
    it("adds to an access list that was already here rather than narrowing it", () => {
        const outcome = run({ groups: "existing" });
        expect(outcome.status).toBe(0);
        expect(outcome.stdout).toContain(
            "added 'polaris' to the SSH access list this machine already had"
        );
        expect(outcome.stdout).not.toContain("limited to the 'polaris' login");
        expect(outcome.remoteLoginOn).toBe(true);
    });

    // Remote Login is already gating SSH on whatever list is there, so the toggle
    // is not touched and the list is only added to.
    it("leaves a Mac that already had Remote Login on as it found it", () => {
        const outcome = run({ remoteLogin: true, groups: "existing" });
        expect(outcome.status).toBe(0);
        expect(outcome.refused).toEqual([]);
        expect(outcome.stdout).toContain("reached: the claim");
        expect(outcome.remoteLoginOn).toBe(true);
    });

    // Turning Remote Login on is the one thing here that widens the machine, and a
    // list nothing could read is not a list known to be safe to open.
    it("will not open a machine whose access list it could not read", () => {
        const outcome = run({ groups: "fail" });
        expect(outcome.status).toBe(1);
        expect(outcome.refused).toEqual(["remote-login-off"]);
        // The switch was never touched, so the machine is exactly as it was found.
        expect(outcome.remoteLoginOn).toBe(false);
        expect(outcome.stderr).toContain("would not say whether it has an SSH access list");
    });

    it("treats a directory that answers with nothing the same way", () => {
        const outcome = run({ groups: "empty" });
        expect(outcome.status).toBe(1);
        expect(outcome.refused).toEqual(["remote-login-off"]);
        expect(outcome.remoteLoginOn).toBe(false);
    });

    // Full Disk Access refuses the change and systemsetup says so on stdout, so the
    // read-back is what catches it.
    it("stops when the toggle would not move, rather than claiming it did", () => {
        const outcome = run({ systemsetup: "refuse-enable" });
        expect(outcome.status).toBe(1);
        expect(outcome.refused).toEqual(["remote-login-off"]);
        expect(outcome.remoteLoginOn).toBe(false);
    });

    // The narrowing calls can each fail quietly on a managed Mac. Announcing a
    // restriction that did not happen is the one outcome nobody goes back to check,
    // so what was turned on goes back off and the group made for it goes too.
    it("puts Remote Login back off when the narrowing cannot be read back", () => {
        const outcome = run({ dseditgroup: "unreadable" });
        expect(outcome.status).toBe(1);
        expect(outcome.refused).toEqual(["remote-login-unrestricted"]);
        expect(outcome.remoteLoginOn).toBe(false);
        expect(outcome.accessGroup).toBe(false);
        expect(outcome.stdout).not.toContain("limited to the 'polaris' login");
    });

    // Deleting the group first and then failing to switch off left the machine on
    // with no access list at all - wider than doing nothing, on the one path that
    // exists because the switch can refuse. The group is what still gates SSH until
    // the machine says it is off, so it outlives a switch-off that did not take.
    it("keeps the access list when it cannot confirm Remote Login went back off", () => {
        const outcome = run({ dseditgroup: "unreadable", systemsetup: "refuse-disable" });
        expect(outcome.status).toBe(1);
        expect(outcome.remoteLoginOn).toBe(true);
        expect(outcome.accessGroup).toBe(true);
    });

    // Two outcomes this far apart cannot share a sentence: the dashboard is where
    // this gets read, and "go and turn it on" is the wrong thing to tell somebody
    // whose machine is on and open right now.
    it("reports a machine left open under its own code, not the reverted one", () => {
        const outcome = run({ dseditgroup: "unreadable", systemsetup: "refuse-disable" });
        expect(outcome.refused).toEqual(["remote-login-left-open"]);
        expect(outcome.stderr).toContain("may be reachable over SSH right now");
    });

    // dseditgroup missing under the sudo PATH is the same thing as a narrowing that
    // did not take: unreadable is not a yes.
    it("does not leave a machine open because the group tool was not there", () => {
        const outcome = run({ dseditgroup: "missing" });
        expect(outcome.status).toBe(1);
        expect(outcome.remoteLoginOn).toBe(false);
        expect(outcome.refused).toEqual(["remote-login-unrestricted"]);
    });

    // An access list that already lets everybody in is the operator's to keep, but
    // Remote Login is on now because of this script, so who it lets in is said.
    it("says out loud when the list it was not allowed to narrow lets everybody in", () => {
        const outcome = run({ groups: "existing", everyone: true });
        expect(outcome.status).toBe(0);
        expect(outcome.stdout).toContain(
            "WARNING: turned Remote Login on, and left the SSH access list alone"
        );
        expect(outcome.remoteLoginOn).toBe(true);
    });
});
