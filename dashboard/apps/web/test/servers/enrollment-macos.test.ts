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
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
    // The `else` that hands over to the Linux half, found from the first thing that
    // half declares rather than from the line right after it - a comment moving in
    // above it is not a reason for this to slice the branch in the wrong place.
    const end = script.lastIndexOf("\nelse\n", script.indexOf("SSH_PROBE=none"));
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
        # A machine that answers while the switch is off and then stops: the toggle
        # moved, or it did not, and this one will no longer say which.
        if [ "\${SYSTEMSETUP_MODE:-ok}" = "mute-once-on" ] && [ -f "\$STATE/on" ]; then
            echo "setremotelogin: this operation requires Full Disk Access"
        elif [ -f "\$STATE/on" ]; then echo "Remote Login: On"; else echo "Remote Login: Off"; fi ;;
    -setremotelogin)
        shift
        if [ "\${1:-}" = "-f" ]; then shift; fi
        case "\${SYSTEMSETUP_MODE:-ok}" in
            refuse-enable) if [ "\$1" = "on" ]; then exit 1; fi ;;
            refuse-disable) if [ "\$1" = "off" ]; then exit 1; fi ;;
        esac
        case "\$1" in
            on)
                # What the machine looked like at the instant sshd went on the
                # network. Whether the list gated it then is the whole question:
                # afterwards is a window, however short.
                if [ ! -f "\$STATE/group" ] || [ ! -f "\$STATE/member" ] || [ -f "\$STATE/everyone" ]; then
                    : > "\$STATE/enabled_open"
                fi
                : > "\$STATE/on" ;;
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
        # An edit against a group that is not there is a write whose behavior Apple
        # has never contracted to keep, so the script is not allowed to make one.
        if [ ! -f "\$STATE/group" ]; then : > "\$STATE/edit_without_group"; fi
        # 'refuse-add' is the managed Mac whose list this cannot be put on: the call
        # reports nothing, and only reading the membership back says it did nothing.
        if [ "\${DSEDIT_MODE:-ok}" = "refuse-add" ]; then exit 1; fi
        case "\$*" in
            *"-d everyone"*) rm -f "\$STATE/everyone" ;;
            *"-a polaris"*) : > "\$STATE/member" ;;
        esac
        exit 0 ;;
    checkmember)
        if [ "\${DSEDIT_MODE:-ok}" = "unreadable" ]; then echo "could not be read"; exit 1; fi
        # A directory that answers until the switch moves and then stops: the only
        # way left to reach the revert, now that the narrowing is read back before
        # Remote Login is turned on rather than after.
        if [ "\${DSEDIT_MODE:-ok}" = "unreadable-once-on" ] && [ -f "\$STATE/on" ]; then
            echo "could not be read"; exit 1
        fi
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
    /** Whether the group edits take and can be read back afterwards, and whether the
     *  tool is even resolvable under the sudo PATH. `unreadable-once-on` is a
     *  directory that answers until Remote Login goes on and then stops. */
    readonly dseditgroup?: "ok" | "unreadable" | "unreadable-once-on" | "missing" | "refuse-add";
    /** Whether the toggle refuses, the way it does without Full Disk Access.
     *  `mute-once-on` is a machine that reports the switch until it is asked to
     *  move it and then stops saying whether it did. */
    readonly systemsetup?: "ok" | "refuse-enable" | "refuse-disable" | "mute-once-on";
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
    /** Whether Remote Login was ever turned on while nothing yet held SSH to the
     *  Polaris login - the window this preflight exists to not open. */
    readonly enabledOpen: boolean;
    /** Whether a group edit was issued against a list that was not there. */
    readonly editWithoutGroup: boolean;
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
        enabledOpen: read("enabled_open") !== null,
        editWithoutGroup: read("edit_without_group") !== null,
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

// Each test shells out through the real harness, which itself shells out again to
// the systemsetup/dscl/dseditgroup/curl stubs - nested process spawns that run well
// past vitest's default 5s budget on this machine, timeout rather than a script defect.
// 20s was still not enough once other test files are spawning subprocesses in
// parallel during a full-suite run, so this gives it more headroom under load.
vi.setConfig({ testTimeout: 60000 });

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

    // sshd goes on the network the instant the switch moves, letting in whatever the
    // access list says - so a list built afterwards leaves a window in which every
    // password-bearing account on the machine is reachable. Short, but the same
    // window the surrounding comment says this branch exists to prevent.
    it("has the list gating SSH before Remote Login goes on", () => {
        const outcome = run();
        expect(outcome.enabledOpen).toBe(false);
        expect(outcome.remoteLoginOn).toBe(true);
    });

    // The same holds where the list was already here: the login is on it before the
    // switch moves, because macOS turns an unlisted one away.
    it("has the login on an existing list before Remote Login goes on", () => {
        const outcome = run({ groups: "existing" });
        expect(outcome.enabledOpen).toBe(false);
        expect(outcome.remoteLoginOn).toBe(true);
    });

    // The narrowing is three calls that can each fail quietly on a managed Mac, and
    // reading it back afterwards is a machine already open while the answer comes in.
    // So the switch does not move at all until the list is known to hold.
    it("never turns Remote Login on when the list it built cannot be read back", () => {
        const outcome = run({ dseditgroup: "unreadable" });
        expect(outcome.enabledOpen).toBe(false);
        expect(outcome.remoteLoginOn).toBe(false);
        expect(outcome.refused).toEqual(["remote-login-unrestricted"]);
        expect(outcome.stderr).toContain("was left off, the way this found it");
        // The group made for a switch that never moved does not outlive it.
        expect(outcome.accessGroup).toBe(false);
    });

    // Same for a switch that would not move for its own reasons: the list was built
    // for it and goes again, so nothing is left behind to restrict SSH to a login
    // the operator never asked for the next time they enable Remote Login by hand.
    it("takes the list it built back when the toggle refuses", () => {
        const outcome = run({ systemsetup: "refuse-enable" });
        expect(outcome.refused).toEqual(["remote-login-off"]);
        expect(outcome.remoteLoginOn).toBe(false);
        expect(outcome.accessGroup).toBe(false);
    });

    // A machine that will not say whether the switch moved is one whose group has
    // to stay - it is the only thing holding SSH to one login if it did move. What
    // it cannot be is left there unmentioned: the group was not here before this
    // ran, and 'Remote Login is off, go and turn it on' would send the operator to
    // enable SSH against a list they never made and be turned away by it.
    it("says it left the list it built behind when the toggle cannot be confirmed", () => {
        const outcome = run({ systemsetup: "mute-once-on" });
        expect(outcome.status).toBe(1);
        expect(outcome.accessGroup).toBe(true);
        // Its own code, and never the one that renders as "turn Remote Login on".
        expect(outcome.refused).toEqual(["ssh-access-list-left-behind"]);
        expect(outcome.stderr).toContain("SSH here was limited to the 'polaris' login");
        expect(outcome.stderr).toContain("dseditgroup -o delete com.apple.access_ssh");
        // The window this branch exists to close stays closed on the way through.
        expect(outcome.enabledOpen).toBe(false);
        expect(outcome.stdout).not.toContain("reached: the claim");
    });

    // Only where the list is this script's own, though: a machine that already had
    // one had nothing left behind on it, so there is nothing new to report.
    it("does not report a leftover list on a machine that already had one", () => {
        const outcome = run({ groups: "existing", systemsetup: "mute-once-on" });
        expect(outcome.status).toBe(1);
        expect(outcome.refused).toEqual(["remote-login-off"]);
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
        // Its own code: 'remote-login-off' renders as "turn it on under Sharing",
        // which is the action this just refused as unsafe, and says nothing about
        // the list that was the reason. The dashboard is where this gets read.
        expect(outcome.refused).toEqual(["ssh-access-list-unrestricted"]);
        // The switch was never touched, so the machine is exactly as it was found.
        expect(outcome.remoteLoginOn).toBe(false);
        expect(outcome.stderr).toContain("would not say whether it has an SSH access list");
        expect(outcome.stderr).toContain("was left off exactly as found");
    });

    it("treats a directory that answers with nothing the same way", () => {
        const outcome = run({ groups: "empty" });
        expect(outcome.status).toBe(1);
        expect(outcome.refused).toEqual(["ssh-access-list-unrestricted"]);
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

    // The list is read back once more with Remote Login on, because that is the
    // state the sentence describes - and a directory that stopped answering in
    // between is a restriction nobody can vouch for. Announcing one that did not
    // happen is the outcome nobody goes back to check, so what was turned on goes
    // back off and the group made for it goes too.
    it("puts Remote Login back off when the narrowing cannot be read back", () => {
        const outcome = run({ dseditgroup: "unreadable-once-on" });
        expect(outcome.status).toBe(1);
        expect(outcome.refused).toEqual(["remote-login-unrestricted"]);
        expect(outcome.remoteLoginOn).toBe(false);
        expect(outcome.accessGroup).toBe(false);
        expect(outcome.stdout).not.toContain("limited to the 'polaris' login");
        expect(outcome.stderr).toContain("was put back off");
    });

    // Deleting the group first and then failing to switch off left the machine on
    // with no access list at all - wider than doing nothing, on the one path that
    // exists because the switch can refuse. The group is what still gates SSH until
    // the machine says it is off, so it outlives a switch-off that did not take.
    it("keeps the access list when it cannot confirm Remote Login went back off", () => {
        const outcome = run({ dseditgroup: "unreadable-once-on", systemsetup: "refuse-disable" });
        expect(outcome.status).toBe(1);
        expect(outcome.remoteLoginOn).toBe(true);
        expect(outcome.accessGroup).toBe(true);
    });

    // Two outcomes this far apart cannot share a sentence: the dashboard is where
    // this gets read, and "go and turn it on" is the wrong thing to tell somebody
    // whose machine is on and open right now.
    it("reports a machine left open under its own code, not the reverted one", () => {
        const outcome = run({ dseditgroup: "unreadable-once-on", systemsetup: "refuse-disable" });
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

    // An access list that already lets everybody in is the operator's to keep - and
    // it is also what Remote Login lets in the moment this switches it on, which is
    // every password-bearing account on the machine, wider than either argument this
    // command makes people opt into. Narrowing it is not this script's call and
    // neither is opening it, so the switch stays where it was found.
    it("will not turn Remote Login on against a list that lets every account in", () => {
        const outcome = run({ groups: "existing", everyone: true });
        expect(outcome.status).toBe(1);
        expect(outcome.refused).toEqual(["ssh-access-list-unrestricted"]);
        // Left exactly as found: the switch untouched and the list unnarrowed.
        expect(outcome.remoteLoginOn).toBe(false);
        expect(outcome.accessGroup).toBe(true);
        expect(outcome.stderr).toContain("lets every account here in");
    });

    // Same reading, same answer: a list whose membership nothing could report is not
    // a list known to be safe to open either.
    it("will not turn Remote Login on against a list it cannot read the members of", () => {
        const outcome = run({ groups: "existing", dseditgroup: "unreadable" });
        expect(outcome.status).toBe(1);
        expect(outcome.refused).toEqual(["ssh-access-list-unrestricted"]);
        expect(outcome.remoteLoginOn).toBe(false);
    });

    // The list is what macOS turns an unlisted login away with, so a machine whose
    // list this login cannot be put on would answer Polaris and then refuse it - the
    // spent token and the report about the wrong thing that this whole preflight
    // exists to catch here instead. Opening the machine for that is the worse half.
    it("does not open a machine for a login its access list would turn away", () => {
        const outcome = run({ groups: "existing", dseditgroup: "refuse-add" });
        expect(outcome.status).toBe(1);
        expect(outcome.refused).toEqual(["not-in-ssh-access-list"]);
        expect(outcome.remoteLoginOn).toBe(false);
        expect(outcome.stdout).not.toContain("added 'polaris'");
    });

    // Remote Login here is nobody's doing but the operator's, so nothing is left
    // wider than it was found - but the login still has to be on the list, and this
    // was announced on somebody else's membership rather than read back.
    it("stops on an already-on Mac whose access list will not take the login", () => {
        const outcome = run({ remoteLogin: true, groups: "existing", dseditgroup: "refuse-add" });
        expect(outcome.status).toBe(1);
        expect(outcome.refused).toEqual(["not-in-ssh-access-list"]);
        expect(outcome.remoteLoginOn).toBe(true);
        expect(outcome.stdout).not.toContain("added 'polaris'");
    });

    // A list that already admits everyone admits the Polaris login too, so an add
    // that did not take costs nothing there.
    it("carries on when the list it could not be added to lets everybody in anyway", () => {
        const outcome = run({
            remoteLogin: true,
            groups: "existing",
            everyone: true,
            dseditgroup: "refuse-add"
        });
        expect(outcome.status).toBe(0);
        expect(outcome.stdout).toContain("already lets every account here in");
        expect(outcome.stdout).toContain("reached: the claim");
    });

    // A membership nobody could read is the question going unasked, and stranding an
    // enrollment on one is what every check here is written not to do - the more so
    // on the path that leaves the machine exactly as it found it.
    it("does not refuse an already-on Mac over a membership it could not read", () => {
        const outcome = run({ remoteLogin: true, groups: "existing", dseditgroup: "unreadable" });
        expect(outcome.status).toBe(0);
        expect(outcome.refused).toEqual([]);
        expect(outcome.stdout).toContain("could not read back whether 'polaris' is on");
        expect(outcome.stdout).toContain("reached: the claim");
    });

    // No list at all means macOS gates SSH on nothing, so there is nothing to be on
    // and nothing to create - creating one would narrow a machine whose SSH this
    // script did not turn on. The add is not issued either: it rested on
    // 'dseditgroup -o edit' being a no-op against a group that is not there, and a
    // release that created it instead would restrict SSH here to the Polaris login.
    it("leaves an already-on Mac with no access list alone", () => {
        const outcome = run({ remoteLogin: true });
        expect(outcome.status).toBe(0);
        expect(outcome.refused).toEqual([]);
        expect(outcome.accessGroup).toBe(false);
        expect(outcome.editWithoutGroup).toBe(false);
        expect(outcome.stdout).toContain("reached: the claim");
    });

    // The reading that decides whether to write is also the one that failed, so
    // nothing is written - and nothing is silently not done either. It is not a
    // refusal: this path leaves the machine as it found it.
    it("says nothing was added when it could not read whether a list exists", () => {
        const outcome = run({ remoteLogin: true, groups: "fail" });
        expect(outcome.status).toBe(0);
        expect(outcome.refused).toEqual([]);
        expect(outcome.editWithoutGroup).toBe(false);
        expect(outcome.stdout).toContain("could not read whether this machine limits SSH to a list of logins");
        expect(outcome.stdout).toContain("reached: the claim");
    });
});
