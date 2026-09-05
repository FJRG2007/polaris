/**
 * Enrollment is the one path where Polaris acts on what an unauthenticated
 * machine tells it, so the two decisions that bound the damage are pinned here:
 * which address it believes, and what the script it hands out actually contains.
 */

import { describe, expect, it } from "vitest";
import { enrollmentCommand, enrollmentScript } from "../../src/lib/enrollment-script";
import {
    ENROLLMENT_REFUSAL_MESSAGES,
    ENROLLMENT_REFUSAL_REASONS,
    ENROLLMENT_RETRY_HINT,
    ENROLLMENT_TTL_MS,
    enrollmentAddressCandidates,
    refuseEnrollmentSchema
} from "@polaris/core";

describe("enrollmentAddressCandidates", () => {
    it("leads with the address it observed over the ones it was told", () => {
        expect(enrollmentAddressCandidates("203.0.113.8", ["10.0.0.5", "192.168.1.7"])).toEqual([
            "203.0.113.8",
            "10.0.0.5",
            "192.168.1.7"
        ]);
    });

    // A machine reaching Polaris through its own public hostname is hairpinned by
    // the router, so the claim is observed arriving from the router. Keeping the
    // reported addresses is the only thing between that and an enrollment that
    // fails on a machine which was reachable all along.
    it("keeps the reported addresses behind an observed one that is not the machine", () => {
        expect(enrollmentAddressCandidates("192.168.1.1", ["192.168.1.142"])).toEqual([
            "192.168.1.1",
            "192.168.1.142"
        ]);
    });

    it("falls back to a reported address when nothing was observed", () => {
        expect(enrollmentAddressCandidates(undefined, ["192.168.1.7"])).toEqual(["192.168.1.7"]);
    });

    it("never offers loopback, which is Polaris's own proxy and not the machine", () => {
        expect(enrollmentAddressCandidates("127.0.0.1", ["192.168.1.7"])).toEqual(["192.168.1.7"]);
        expect(enrollmentAddressCandidates("::1", ["192.168.1.7"])).toEqual(["192.168.1.7"]);
        expect(enrollmentAddressCandidates("127.0.0.1", ["127.0.0.1", "localhost"])).toEqual([]);
    });

    it("has nothing to offer when the machine reported nothing usable", () => {
        expect(enrollmentAddressCandidates(undefined, [])).toEqual([]);
        expect(enrollmentAddressCandidates("", ["  "])).toEqual([]);
    });

    /**
     * The reason this exists at all: a machine on the same switch, enrolled
     * through the public name it reached Polaris by, would otherwise be recorded
     * at that name and reached through the router for the rest of its life -
     * slower for every byte, and gone entirely when the line is.
     */
    it("prefers the address on Polaris's own network when it knows what that is", () => {
        expect(
            enrollmentAddressCandidates("203.0.113.8", ["10.0.0.5", "192.168.1.7"], "192.168.1.50")
        ).toEqual(["192.168.1.7", "10.0.0.5", "203.0.113.8"]);
    });

    it("still knocks on the public address, second", () => {
        // Being near is a reason to try first, never a reason to stop trying:
        // the LAN address may be stale, and the public one may be the only one
        // that answers.
        expect(enrollmentAddressCandidates("203.0.113.8", ["192.168.1.7"], "192.168.1.50")).toContain(
            "203.0.113.8"
        );
    });

    it("orders nothing differently when Polaris is not on a local network itself", () => {
        expect(
            enrollmentAddressCandidates("203.0.113.8", ["10.0.0.5"], "203.0.113.20")
        ).toEqual(["203.0.113.8", "10.0.0.5"]);
        expect(enrollmentAddressCandidates("203.0.113.8", ["10.0.0.5"], null)).toEqual([
            "203.0.113.8",
            "10.0.0.5"
        ]);
    });

    it("does not knock twice on the same address", () => {
        expect(enrollmentAddressCandidates("192.168.1.7", ["192.168.1.7", "10.0.0.5"])).toEqual([
            "192.168.1.7",
            "10.0.0.5"
        ]);
    });

    // Each candidate is an outbound SSH handshake, and a claim is unauthenticated
    // beyond its token, so the list it can send Polaris knocking on is bounded.
    it("bounds how many addresses one claim can send Polaris knocking on", () => {
        const reported = Array.from({ length: 16 }, (_, index) => `10.0.0.${index + 1}`);
        expect(enrollmentAddressCandidates("203.0.113.8", reported)).toHaveLength(6);
    });
});

// The endpoint that takes these is unauthenticated - a caller holds a token and
// nothing else - so what it accepts is the whole boundary.
describe("refuseEnrollmentSchema", () => {
    it("takes a code from the closed set and nothing else", () => {
        for (const reason of ENROLLMENT_REFUSAL_REASONS) {
            expect(refuseEnrollmentSchema.safeParse({ reason }).success).toBe(true);
        }
        expect(refuseEnrollmentSchema.safeParse({ reason: "made-up" }).success).toBe(false);
    });

    // Free text here would be a stranger writing into an operator's dashboard, so
    // the machine picks a code and Polaris owns every word that gets rendered.
    it("never lets the machine supply the sentence Polaris shows", () => {
        expect(refuseEnrollmentSchema.safeParse({ reason: "Your account is locked, call 555-0100" }).success).toBe(
            false
        );
        const parsed = refuseEnrollmentSchema.parse({ reason: "ssh-not-listening" });
        expect(Object.keys(parsed)).toEqual(["reason"]);
        for (const reason of ENROLLMENT_REFUSAL_REASONS) {
            expect(ENROLLMENT_REFUSAL_MESSAGES[reason].length).toBeGreaterThan(0);
        }
    });
});

// Wording the operator sees on two different screens, built from one number so it
// cannot drift away from how long a command actually lives.
describe("ENROLLMENT_RETRY_HINT", () => {
    it("matches the lifetime a command really has", () => {
        expect(ENROLLMENT_RETRY_HINT).toContain(`${ENROLLMENT_TTL_MS / 60_000} minutes`);
        expect(ENROLLMENT_RETRY_HINT).toContain("or generate a new one");
    });
});

describe("enrollmentCommand", () => {
    it("stays a plain pipe into sh so it runs on a minimal box", () => {
        expect(enrollmentCommand("https://polaris.example.com", "tok")).toBe(
            "curl -sSL https://polaris.example.com/api/servers/enroll/tok | sudo sh -s -- --docker --root"
        );
    });

    // A spent or unknown token is answered with a script that says so and exits 1.
    // `-f` discards that body, leaving the operator with `curl: (22) ... 404` and a
    // pipeline that exits 0 - the command looks like it worked and nothing arrives.
    it("does not throw away the body a refusal explains itself in", () => {
        expect(enrollmentCommand("https://polaris.example.com", "tok")).not.toContain("-f");
    });

    // A server Polaris cannot deploy to, run jobs on, or read the filesystem of is
    // one it can do nothing with, so adding a server grants both rather than
    // offering choices that produced registered-but-useless machines. They stay
    // spelled out as arguments so the command still says what it does.
    it("grants container access and root without asking", () => {
        expect(enrollmentCommand("https://polaris.example.com", "tok")).toContain("-- --docker --root");
    });
});

describe("enrollmentScript", () => {
    const script = enrollmentScript({
        baseUrl: "https://polaris.example.com",
        token: "tok",
        username: "polaris",
        publicKey: "ssh-ed25519 AAAAC3Nz polaris-server"
    });

    it("carries no secret - only the public half and the callback", () => {
        expect(script).toContain("ssh-ed25519 AAAAC3Nz polaris-server");
        expect(script).not.toContain("PRIVATE KEY");
    });

    it("asks before granting container access or root", () => {
        expect(script).not.toMatch(/usermod -aG (sudo|wheel|admin)/);
        expect(script).toContain('if [ "$GRANT_DOCKER" = "1" ]');
        expect(script).toContain('if [ "$GRANT_ROOT" = "1" ]');
    });

    // A sudoers file with a syntax error is refused wholesale, which takes root
    // away from everybody on the machine - including whoever is standing in front
    // of it. So the candidate is validated before it is ever in place.
    it("validates the sudo rule on a temporary file before installing it", () => {
        const sudoers = script.slice(script.indexOf('if [ "$GRANT_ROOT" = "1" ]'));
        const validate = sudoers.indexOf("visudo -c -f");
        const install = sudoers.indexOf('mv "$TMP"');
        expect(validate).toBeGreaterThan(-1);
        expect(install).toBeGreaterThan(validate);
        expect(sudoers).toContain('visudo -c -f "$TMP"');
        expect(sudoers).not.toContain('visudo -c -f "$SUDOERS"');
    });

    it("reports what the login ended up able to do, not what was asked for", () => {
        expect(script).toContain('"root":%s');
        expect(script).toContain('sudo -l -U "$POLARIS_USER"');
    });

    it("refuses to run unprivileged rather than failing halfway through", () => {
        expect(script).toContain('[ "$(id -u)" = "0" ] || die not-root "run this with sudo"');
    });

    // Reported at enrollment so a new server says what it runs the moment it
    // appears, instead of staying blank until something goes and asks it.
    it("reports what the machine runs, in the machine's own words", () => {
        expect(script).toContain("/etc/os-release");
        expect(script).toContain("sw_vers -productName");
        expect(script).toContain('"os":"%s"');
        expect(script).toContain('"$OS_NAME"');
    });

    // The value is spliced into a JSON string, and it is free text from a file on
    // somebody else's machine.
    it("strips what would break the JSON it splices the system name into", () => {
        expect(script).toContain("tr -d '\"\\\\'");
        expect(script).toContain("cut -c1-200");
    });

    it("makes the machine commit to its host keys", () => {
        expect(script).toContain("/etc/ssh/ssh_host_*_key.pub");
        expect(script).toContain('"hostKeys":[%s]');
    });

    // A Mac that has never had Remote Login on has no host keys at all, and the
    // enrollment used to die on that last step with the login already created.
    it("mints host keys when the machine has none rather than giving up", () => {
        expect(script).toContain("ssh-keygen -A");
        expect(script).toContain("collect_host_keys");
    });

    // macOS ships with Remote Login off, so the login was configured and then
    // nothing answered - and Polaris, which can only see a connect that times out,
    // reported a firewall problem on a machine that had no SSH server running.
    it("turns Remote Login on rather than handing back a machine nothing can reach", () => {
        // Stdin closed because this script IS stdin: anything that reads from it
        // swallows the rest of the script.
        expect(script).toContain("systemsetup -setremotelogin on </dev/null");
        // Which holds for the read too, and that one runs on every macOS enrollment
        // before anything else has happened - so a systemsetup that touched stdin
        // would swallow the script from its very first line.
        expect(script).toContain("systemsetup -getremotelogin </dev/null");
        const calls = script.slice(script.indexOf("read_remote_login() {")).match(/systemsetup -[a-z]+[^\n]*/g) ?? [];
        expect(calls).toHaveLength(3);
        for (const call of calls) expect(call).toContain("</dev/null");
        // Read back rather than trusted - Full Disk Access can refuse the change,
        // and systemsetup says so on stdout rather than in its exit code.
        expect(script).toContain('*"remote login: on"*) REMOTE_LOGIN=yes');
    });

    // "systemsetup is missing", "it errored" and "it printed something new" all
    // produce no match, and treating that as off aborted enrollments on Macs whose
    // sshd was running the whole time. Only a positive "off" is an answer.
    it("gives macOS the same yes/no/unknown the listener check has", () => {
        expect(script).toContain("REMOTE_LOGIN=unknown");
        expect(script).toContain('*"remote login: off"*) REMOTE_LOGIN=no');
        // The enable attempt, and the refusal, both hang off a positive "off".
        expect(script).toContain('if [ "$REMOTE_LOGIN" = "no" ]');
        expect(script).toContain('if [ "$REMOTE_LOGIN" = "unknown" ]');
        // An unknown reading says so and keeps going rather than dying.
        const unknown = script.slice(script.indexOf('if [ "$REMOTE_LOGIN" = "unknown" ]'));
        expect(unknown.slice(0, unknown.indexOf("fi"))).not.toContain("die ");
    });

    // Remote Login defaults to every local account, so switching it on unasked is
    // wider than either of the arguments the script makes people opt into. It is
    // only narrowed on the path where the script did the switching, though: an
    // access list somebody else set up is not this script's to withdraw.
    it("limits SSH to the Polaris login only when it turned Remote Login on", () => {
        const enabled = script.slice(
            script.indexOf('if [ "$REMOTE_LOGIN" = "no" ]'),
            script.indexOf("turned Remote Login on")
        );
        expect(enabled).toContain("dseditgroup -o create -q com.apple.access_ssh");
        expect(enabled).toContain("dseditgroup -o edit -d everyone -t group com.apple.access_ssh");
        expect(enabled).toContain('dseditgroup -o edit -a "$POLARIS_USER" -t user com.apple.access_ssh');

        // The already-on path adds and never removes.
        const alreadyOn = script.slice(script.indexOf('if [ "$REMOTE_LOGIN" = "unknown" ]'));
        const untilEnd = alreadyOn.slice(0, alreadyOn.indexOf("SSH_PROBE"));
        expect(untilEnd).toContain("add_to_access_list");
        expect(untilEnd).not.toContain("-d everyone");
        expect(untilEnd).not.toContain("-o create");
        // And the one thing that helper does to a list is put a login on it.
        const adder = script.slice(script.indexOf("add_to_access_list() {"));
        const body = adder.slice(0, adder.indexOf("\n    }"));
        expect(body).toContain('dseditgroup -o edit -a "$POLARIS_USER" -t user com.apple.access_ssh');
        expect(body).not.toContain("-d ");
        expect(body).not.toContain("-o create");
        expect(body).not.toContain("-o delete");
    });

    // "Remote Login was off" was never the same question as "this access list is
    // mine to shape": a Mac can have the toggle off and still carry the list its
    // operator built before switching it off, and narrowing that one withdraws
    // access somebody else granted. So what the narrowing hangs off is whether the
    // group existed, read before anything touches it.
    it("narrows only the access list it created itself, never one already here", () => {
        expect(script).toContain("access_ssh_exists() {");
        expect(script).toContain("dscl . -list /Groups");
        expect(script).toContain("ACCESS_LIST=$(access_ssh_exists)");
        // Read before the toggle is changed, so it is the state this script found.
        const darwin = script.slice(script.indexOf("read_remote_login\n"));
        expect(darwin.indexOf("ACCESS_LIST=$(access_ssh_exists)")).toBeLessThan(
            darwin.indexOf("systemsetup -setremotelogin on")
        );
        // Every narrowing call sits inside the "there was no list" branch, which
        // builds one before the switch moves - and nowhere else on this platform
        // does anything create or empty a group.
        const body = darwin.slice(0, darwin.indexOf("SSH_PROBE"));
        const narrowing = body.slice(
            body.indexOf("dseditgroup -o create -q"),
            body.indexOf("systemsetup -setremotelogin on")
        );
        expect(narrowing).toContain("-o create");
        expect(narrowing).toContain("-d everyone");
        expect(body.match(/-o create/g)).toHaveLength(1);
        expect(body.match(/-d everyone/g)).toHaveLength(1);
        // The branch for a list that was already here adds to it and leaves it
        // otherwise alone, exactly like the already-on path.
        const kept = body.slice(body.indexOf('if [ "$ACCESS_LIST" = "yes" ]'), body.indexOf("dseditgroup -o create -q"));
        expect(kept).toContain("ADDED=$(add_to_access_list)");
        expect(kept).not.toContain("-d everyone");
        expect(kept).not.toContain("-o create");
    });

    // A group read that failed is not a group that is absent, and the two used to
    // be the same answer twice over: first any output that did not name the group
    // was "no", and then absence was a refusal whose exact prose had to be
    // recognized - so a wording Apple never promised to keep decided whether a
    // stock Mac could enroll at all. Asking which groups exist makes absence
    // something the answer contains, and leaves only a listing that failed
    // outright as the thing nobody learned.
    it("tells an access list that is not there from one it could not read", () => {
        const reader = script.slice(script.indexOf("access_ssh_exists() {"));
        const body = reader.slice(0, reader.indexOf("\n    }"));
        expect(body).toContain("_groups=$(dscl . -list /Groups 2>/dev/null) || _groups=\"\"");
        // Absence is the listing not naming it, matched whole rather than anywhere
        // in a line, and never parsed out of an error message.
        expect(body).toContain("grep -qxF com.apple.access_ssh");
        expect(body).not.toContain("not found");
        expect(body).not.toContain("edsrecordnotfound");
        // A tool that is not installed and a listing that answered nothing are the
        // only two ways to learn nothing.
        expect(body.match(/echo unknown/g)).toHaveLength(2);
        expect(body).toContain("command -v dscl");
        expect(body).toContain('[ -n "$_groups" ] || { echo unknown; return; }');
    });

    // Turning Remote Login on is the one thing here that widens the machine, and it
    // is only safe on a reading this can act on. An access list nothing could read
    // is not a list known to be safe to open, and the previous shape decided that
    // after the switch was already flipped - so an unreadable group left SSH open
    // to every account on the machine with a printed warning for company.
    it("refuses to enable Remote Login when the access list cannot be read", () => {
        const darwin = script.slice(script.indexOf("read_remote_login\n"));
        const gate = darwin.indexOf('if [ "$ACCESS_LIST" = "unknown" ]');
        expect(gate).toBeGreaterThan(-1);
        // The decision is made while the machine is still as its operator left it.
        expect(gate).toBeLessThan(darwin.indexOf("systemsetup -setremotelogin on"));
        const stop = darwin.slice(gate, darwin.indexOf("systemsetup -setremotelogin on"));
        expect(stop).toContain("die ssh-access-list-unrestricted");
        expect(stop).toContain("would not say whether it has an SSH access list");
    });

    // Sharing a code with the stop that means "Remote Login is off, go and turn it
    // on" told the operator to do the exact thing the machine just refused as
    // unsafe - and the dashboard, which is where this gets read, said nothing about
    // the access list that was the reason.
    it("does not tell the dashboard to turn on what it refused to turn on", () => {
        const message = ENROLLMENT_REFUSAL_MESSAGES["ssh-access-list-unrestricted"];
        expect(message).toContain("access list");
        expect(message).toContain("left off");
        expect(message).not.toMatch(/turn it on under/i);
        // The terminal and the dashboard say the same thing, which is the whole
        // point of the code: only one of the two is guaranteed to be read.
        for (const stop of script.match(/die ssh-access-list-unrestricted "[^"]*"/g) ?? []) {
            expect(stop).toContain("was left off exactly as found");
            expect(stop).toContain("Look at which logins that list admits");
        }
        expect(script.match(/die ssh-access-list-unrestricted/g)).toHaveLength(2);
    });

    // Remote Login is on by the time this is decided either way, so what it says
    // has to be what happened: which of the two lists it ended up with, and whether
    // the login it added is one it could actually read back.
    it("says which of the two access lists it ended up with", () => {
        expect(script).toContain("turned Remote Login on, limited to the '$POLARIS_USER' login");
        expect(script).toContain(
            "turned Remote Login on and added '$POLARIS_USER' to the SSH access list this machine already had"
        );
        expect(script).toContain("whether '$POLARIS_USER' is on it could not be read back");
    });

    // A list that already admits everyone makes the switch the thing that hands the
    // network every password-bearing account on the machine - wider than either
    // argument this command makes people opt into, and a printed warning afterwards
    // does not take it back, since nobody is obliged to be reading the terminal.
    // Narrowing that list is not this script's call either, so the switch is left
    // where it was found and the choice goes back to whoever built the list.
    it("will not open a machine whose existing access list admits everyone", () => {
        const darwin = script.slice(script.indexOf("read_remote_login\n"));
        const gate = darwin.indexOf('[ "$(access_ssh_member everyone group)" != "no" ]');
        expect(gate).toBeGreaterThan(-1);
        // Decided while the machine is still as its operator left it.
        expect(gate).toBeLessThan(darwin.indexOf("systemsetup -setremotelogin on"));
        expect(darwin.slice(gate, darwin.indexOf("systemsetup -setremotelogin on"))).toContain(
            "die ssh-access-list-unrestricted"
        );
        // And the warning it used to carry on past is gone.
        expect(script).not.toContain("WARNING: turned Remote Login on, and left the SSH access list alone");
    });

    // The access list is what macOS turns an unlisted login away with, so an add
    // that quietly did nothing is a machine that answers Polaris and then refuses
    // it - a spent token and "check the firewall", which is the misdiagnosis this
    // whole preflight exists to catch on the machine instead. It used to be
    // announced on somebody else's membership and never read back.
    it("reads back the login's own membership before announcing it", () => {
        const adder = script.slice(script.indexOf("add_to_access_list() {"));
        expect(adder.slice(0, adder.indexOf("\n    }"))).toContain('access_ssh_member "$POLARIS_USER" user');
        expect(script.match(/die not-in-ssh-access-list/g)).toHaveLength(2);
        // The already-on path refuses only on a list that was read and says no: an
        // answer nobody got has never been allowed to strand an enrollment.
        const alreadyOn = script.slice(script.indexOf('if [ "$REMOTE_LOGIN" = "unknown" ]'));
        const untilEnd = alreadyOn.slice(0, alreadyOn.indexOf("SSH_PROBE"));
        expect(untilEnd).toContain('[ "$ADDED" = "no" ]');
        expect(untilEnd).toContain("could not read back whether '$POLARIS_USER' is on");
        expect(untilEnd.slice(untilEnd.indexOf("could not read back"))).not.toContain("die ");
        // And a list that lets everybody in lets this login in too, so that one is
        // not a machine to refuse either.
        expect(untilEnd).toContain("already lets every account here in");
    });

    // Each dseditgroup call can fail quietly on a managed Mac, and by then Remote
    // Login is already on. Announcing a restriction that did not happen is the one
    // outcome nobody goes back to check, so the group is re-read the same way the
    // Remote Login state is and the claim is made only on what it says.
    it("only claims the SSH narrowing it can read back", () => {
        expect(script).toContain("dseditgroup -o checkmember");
        const enabled = script.slice(script.indexOf("dseditgroup -o create -q"));
        const decided = enabled.slice(0, enabled.indexOf('say "turned Remote Login on'));
        expect(decided).toContain('[ "$(access_ssh_member "$POLARIS_USER" user)" = "yes" ]');
        expect(decided).toContain('[ "$(access_ssh_member everyone group)" != "yes" ]');
        const reader = script.slice(script.indexOf("access_ssh_member() {"));
        expect(reader.slice(0, reader.indexOf("\n    }"))).toContain("*) echo unknown ;;");
    });

    // The switch is what puts sshd on the network, and what it lets in the instant
    // it moves is whatever the access list says. Building the list afterwards left a
    // window - the enable, its read-back, three dseditgroup calls - in which every
    // password-bearing account on the machine was reachable over SSH, which is the
    // thing this branch's own comment says it exists to prevent.
    it("builds the access list before it turns Remote Login on, not after", () => {
        const darwin = script.slice(script.indexOf("read_remote_login\n"));
        const enable = darwin.indexOf("systemsetup -setremotelogin on");
        expect(darwin.indexOf("dseditgroup -o create -q")).toBeLessThan(enable);
        expect(darwin.indexOf("dseditgroup -o edit -d everyone")).toBeLessThan(enable);
        expect(darwin.indexOf('dseditgroup -o edit -a "$POLARIS_USER"')).toBeLessThan(enable);
        // And a narrowing that could not be read back stops the switch from ever
        // moving, the way the paths either side of it do.
        const built = darwin.slice(darwin.indexOf("dseditgroup -o create -q"), enable);
        expect(built).toContain('[ "$(access_ssh_member "$POLARIS_USER" user)" != "yes" ]');
        expect(built).toContain('[ "$(access_ssh_member everyone group)" = "yes" ]');
        expect(built).toContain("die remote-login-unrestricted");
        // The group made for a switch that never moved goes with it.
        expect(built.indexOf("dseditgroup -o delete")).toBeLessThan(built.indexOf("die remote-login-unrestricted"));
        expect(built).toContain("was left off, the way this found it");
    });

    // Only once the machine says the switch is off, though: a delete on an "on" or
    // an unreadable answer would strip the one thing gating SSH to a single login.
    it("keeps the list it built when the failed enable cannot be confirmed off", () => {
        const darwin = script.slice(script.indexOf("read_remote_login\n"));
        const stop = darwin.slice(darwin.indexOf('if [ "$REMOTE_LOGIN" != "yes" ]'));
        const untilDie = stop.slice(0, stop.indexOf("die remote-login-off"));
        expect(untilDie).toContain('[ "$ACCESS_LIST" = "no" ] && [ "$REMOTE_LOGIN" = "no" ]');
        expect(untilDie).toContain("dseditgroup -o delete com.apple.access_ssh");
    });

    // A group that stays is a change to the machine that outlives the run, and
    // 'remote-login-off' renders as "turn Remote Login on" - which would send its
    // operator to enable SSH against a list they never made and be turned away from
    // their own Mac by it. So the state the machine is actually left in gets said,
    // in the terminal and in the sentence the dashboard stores.
    it("says it left the list it built behind rather than only that the switch is off", () => {
        const darwin = script.slice(script.indexOf("read_remote_login\n"));
        const stop = darwin.slice(darwin.indexOf('if [ "$REMOTE_LOGIN" != "yes" ]'));
        const untilDie = stop.slice(0, stop.indexOf("die remote-login-off"));
        // The arm of the same reading whose other half deletes the group: this one
        // keeps it, because an unconfirmed switch may well be on.
        expect(untilDie).toContain('elif [ "$ACCESS_LIST" = "no" ]; then');
        expect(untilDie).toContain("die ssh-access-list-left-behind");
        const message = ENROLLMENT_REFUSAL_MESSAGES["ssh-access-list-left-behind"];
        // The terminal and the dashboard say the same thing, which is the whole
        // point of the code: only one of the two is guaranteed to be read.
        for (const part of [
            "limited to the",
            "would not say whether Remote Login is on or off",
            "dseditgroup -o delete com.apple.access_ssh"
        ]) {
            expect(untilDie).toContain(part);
            expect(message).toContain(part);
        }
        expect(message).not.toMatch(/turn it on under/i);
    });

    // A warning was all that stood between an unreadable narrowing and a machine
    // reachable over SSH by every account on it - and nobody is obliged to be
    // watching the terminal. An unreadable answer is not a yes, so what was turned
    // on goes back off, the group this script made goes with it, and the stop is
    // reported like any other rather than printed and walked past.
    it("puts Remote Login back off when it cannot read back the narrowing it made", () => {
        const enabled = script.slice(script.indexOf("dseditgroup -o create -q"));
        const failed = enabled.slice(enabled.indexOf("\n            else"), enabled.indexOf("\n        else"));
        expect(failed).toContain("dseditgroup -o delete com.apple.access_ssh");
        // -f suppresses the confirmation, which systemsetup only asks on the way
        // off - and stdin is this script, so nothing can answer it.
        expect(failed).toContain("systemsetup -setremotelogin -f off </dev/null");
        expect(failed).toContain("die remote-login-unrestricted");
        expect(failed).not.toContain("say ");
        // The switch goes first and the group second, because the switch is the one
        // that can refuse: until the machine says Remote Login is off, that group is
        // whatever still gates SSH to one login, and deleting it first turned a
        // failed switch-off into a machine open to every account on it.
        expect(failed.indexOf("systemsetup -setremotelogin -f off")).toBeLessThan(
            failed.indexOf("dseditgroup -o delete")
        );
        // 'off' is claimed only on a machine that says it is off; anything else is
        // told to the operator as a machine that may be open right now.
        expect(failed).toContain('if [ "$REMOTE_LOGIN" = "no" ]');
        expect(failed).toContain("could not confirm it went back off");
        expect(script).not.toContain("WARNING: turned Remote Login on, but SSH could not be limited");
    });

    // One code for both halves told the dashboard to go and turn Remote Login on -
    // right for the machine that was put back off, and the exact wrong thing to say
    // about one that is on and open right now. The terminal is not where this gets
    // read, so the state the machine was left in is what the code has to carry.
    it("does not report a machine left open as one that was put back safely", () => {
        const enabled = script.slice(script.indexOf("dseditgroup -o create -q"));
        const failed = enabled.slice(enabled.indexOf("\n            else"), enabled.indexOf("\n        else"));
        const reverted = failed.indexOf("die remote-login-unrestricted");
        const open = failed.indexOf("die remote-login-left-open");
        expect(reverted).toBeGreaterThan(-1);
        expect(open).toBeGreaterThan(reverted);
        // The reverted one is the arm of the read-back, and the open one is what is
        // left when that read did not say "off".
        expect(failed.slice(reverted, open)).toContain("was put back off");
        expect(failed.slice(open)).toContain("may be reachable over SSH right now");
        expect(ENROLLMENT_REFUSAL_MESSAGES["remote-login-left-open"]).toContain("may be reachable over SSH right now");
        // And Polaris's own sentence for it does not send anybody to switch on what
        // is already on.
        expect(ENROLLMENT_REFUSAL_MESSAGES["remote-login-left-open"]).not.toMatch(/turn it on/i);
        // One sentence for a machine this may never have opened at all - the
        // narrowing is checked before the switch moves - and for one it put back:
        // both end with Remote Login off the way the command found it, and neither
        // is told a revert happened that may not have.
        expect(ENROLLMENT_REFUSAL_MESSAGES["remote-login-unrestricted"]).toContain("left off");
        expect(ENROLLMENT_REFUSAL_MESSAGES["remote-login-unrestricted"]).not.toContain("put back off");
    });

    it("says how to undo the Remote Login changes it can make", () => {
        expect(script).toContain("sudo systemsetup -setremotelogin off");
        expect(script).toContain("sudo dseditgroup -o delete com.apple.access_ssh");
    });

    // Stopping here leaves the token unspent, so the same command works again once
    // the SSH server is on. Claiming first would burn it for nothing.
    it("stops before the claim when nothing will answer on the SSH port", () => {
        const preflight = script.indexOf("nothing Polaris could reach is listening on any port");
        expect(preflight).toBeGreaterThan(-1);
        expect(preflight).toBeLessThan(script.indexOf("telling Polaris about this machine"));
        expect(script).toContain('die remote-login-off "Remote Login is off');
    });

    // "Something holds the port" was never the question. An sshd on 127.0.0.1
    // answers this machine and nobody else, so letting it through registers a
    // server Polaris then cannot reach - and reports as a firewall problem, which
    // is the exact misdiagnosis this check exists to prevent.
    it("wants a bind Polaris could dial, not merely a listener", () => {
        const probe = script.slice(script.indexOf("reachable_listener() {"));
        const matcher = probe.slice(0, probe.indexOf("owned_by() {"));
        expect(matcher).toContain("/^\\[?127\\./");
        expect(matcher).toContain('addr == "::1"');
        expect(matcher).toContain('addr == "[::1]"');
        // The port alone is not the match any more; the address column decides.
        expect(script).not.toContain('grep -q ":$1 "');
        expect(script).toContain('"$LISTENERS_PLAIN" | reachable_listener "$1" ""');
    });

    // Neither tool takes -p on every vintage, and one that does not prints nothing
    // at all with it - which must not read as a machine with nothing listening.
    it("asks for the owning process without letting the answer be all it has", () => {
        expect(script).toContain("ss -ltnp 2>/dev/null");
        expect(script).toContain("ss -ltn 2>/dev/null");
        expect(script).toContain("netstat -lntp 2>/dev/null");
        expect(script).toContain("netstat -lnt 2>/dev/null");
    });

    // Neither table changes while the preflight runs, and re-deriving them per
    // candidate port meant up to 2N+1 ss/netstat runs and a check reasoning about
    // several snapshots taken milliseconds apart instead of one.
    it("takes the listener tables once rather than once per candidate port", () => {
        expect(script).toContain("LISTENERS_OWNED=$(ss -ltnp 2>/dev/null || true)");
        expect(script).toContain("LISTENERS_PLAIN=$(ss -ltn 2>/dev/null || true)");
        expect(script).toContain("LISTENERS_OWNED=$(netstat -lntp 2>/dev/null || true)");
        expect(script).toContain("LISTENERS_PLAIN=$(netstat -lnt 2>/dev/null || true)");
        const probe = script.slice(script.indexOf("SSH_PROBE=none"));
        // Taken before anything reads them, and read from the variable after.
        expect(probe.indexOf("LISTENERS_OWNED=$(ss -ltnp")).toBeLessThan(probe.indexOf("for port in $SSH_PORTS; do"));
        expect(probe).not.toContain("$(listeners ");
    });

    // awk is part of the instrument, not a detail of it: the candidate ports, the
    // listener table and the owner match all go through one, so a machine without it
    // found nothing on every candidate and refused an sshd that was running fine.
    it("counts awk among the tools the check needs before it may refuse", () => {
        const probe = script.slice(script.indexOf("SSH_PROBE=none"));
        const select = probe.slice(0, probe.indexOf("reachable_listener() {"));
        expect(select).toContain("command -v awk");
        // And nothing selects a probe without it.
        expect(select.indexOf("command -v awk")).toBeLessThan(select.indexOf("command -v ss"));
        expect(select).toMatch(/command -v awk[\s\S]*SSH_PROBE=ss/);
        expect(script).toContain("no awk, ss or netstat here");
    });

    // A box with neither tool cannot answer the question, and a wrong "nothing is
    // listening" would strand an enrollment that was fine.
    it("only refuses on a listener check it could actually run", () => {
        expect(script).toContain("SSH_PROBE=none");
        expect(script).toContain('if [ "$SSH_PROBE" = "none" ]');
        // Three states, and only the flat "no" reaches the refusal.
        expect(script).toContain("SSH_LISTENING=unknown");
        expect(script).toContain('case "$SSH_LISTENING" in');
        const decision = script.slice(script.indexOf('case "$SSH_LISTENING" in'));
        const arms = decision.slice(0, decision.indexOf("esac"));
        expect(arms).toMatch(/unknown\)[^\n]*say/);
        expect(arms).toMatch(/\*\)[^\n]*die ssh-not-listening/);
        expect(arms.slice(0, arms.indexOf("*)"))).not.toContain("die ");
    });

    // A listener whose owner nothing could read is not sshd - it is the question
    // going unanswered. Letting it pick the port put the machine's own check behind
    // "could not reach the machine's SSH port from here. Check the firewall", which
    // is the report this check exists to stop producing; letting it refuse would
    // strand an enrollment on an ss too old for -p. So it does neither.
    it("does not let an unidentified listener stand in for the SSH server", () => {
        const probe = script.slice(script.indexOf("SSH_PROBE=none"));
        // The bare-listener sweep runs after the owned ones and never becomes a yes.
        const bare = probe.slice(probe.indexOf('if [ "$SSH_LISTENING" != "yes" ]'));
        const untilDecision = bare.slice(0, bare.indexOf('case "$SSH_LISTENING" in'));
        expect(untilDecision).toContain('if listening_on "$port"');
        expect(untilDecision).toContain("SSH_LISTENING=unknown");
        expect(untilDecision).not.toContain("SSH_LISTENING=yes");
    });

    // Which port the unanswered question reports is still a choice, and it was being
    // made in favour of the guess already known to be wrong: with a config naming
    // 2222 first and an unattributable listener only on 22, the claim went out for
    // 2222 - a port this very sweep had just found nothing on - while 22 was seen
    // answering. Both are guesses; the reported one is now the observed one, which
    // is also what makes the sentence printed alongside it true.
    it("reports the port an unidentified listener was seen on", () => {
        const probe = script.slice(script.indexOf("SSH_PROBE=none"));
        const bare = probe.slice(probe.indexOf('if [ "$SSH_LISTENING" != "yes" ]'));
        const sweep = bare.slice(0, bare.indexOf('case "$SSH_LISTENING" in'));
        expect(sweep.indexOf("SSH_PORT=$port")).toBeGreaterThan(sweep.indexOf('if listening_on "$port"'));
        expect(sweep.indexOf("SSH_PORT=$port")).toBeLessThan(sweep.indexOf("SSH_LISTENING=unknown"));
        expect(script).toContain("so port $SSH_PORT is what gets reported");
    });

    // Socket activation is the one case a candidate port still settles: sshd owns
    // nothing until the first connection, systemd holds the socket, and the port
    // says which of systemd's many sockets is the SSH one.
    it("takes a systemd-held socket only on a port this machine declares", () => {
        expect(script).toContain('if owned_by "$port" systemd');
        const probe = script.slice(script.indexOf("SSH_PROBE=none"));
        expect(probe.indexOf('owned_by "$port" systemd')).toBeLessThan(probe.indexOf('listening_on "$port"'));
    });

    // `index($0, "sshd")` matched anywhere on the line, so a process merely named
    // like sshd was taken for it. ss writes the name as ("sshd",...) and netstat as
    // 812/sshd, which with the quotes dropped is the name behind a '(' or a '/'.
    it("matches the owner as a process name rather than anywhere in the line", () => {
        const probe = script.slice(script.indexOf("reachable_listener() {"));
        const matcher = probe.slice(0, probe.indexOf("owned_by() {"));
        expect(matcher).not.toContain("index($0, owner)");
        expect(matcher).toContain('gsub(/"/, "", named)');
        expect(matcher).toContain('named !~ "[(/]" owner "([^A-Za-z0-9_-]|$)"');
    });

    // The old parse took the first `Port` in sshd_config and made it the only
    // thing the abort was gated on. That misses the dropped-in file Debian 12 and
    // Ubuntu 22.10+ put the port in, and means nothing at all under systemd socket
    // activation, where ssh.socket decides and the config is ignored.
    it("treats every configured port as a candidate, plus 22 always", () => {
        expect(script).toContain('tolower($1) == "include"');
        expect(script).toContain('tolower($1) == "port"');
        // A relative Include is resolved the way sshd resolves it.
        expect(script).toContain('*) _pattern="/etc/ssh/$_pattern" ;;');
        expect(script).toContain("for port in $(ssh_configured_ports) 22; do");
    });

    // A port does not only come from a `Port` line. `ListenAddress 10.0.0.5:2222`
    // sets one with no `Port` anywhere, and on Ubuntu 24.04+ the documented way to
    // move SSH is `systemctl edit ssh.socket`, which never touches sshd_config at
    // all. Reading only `Port` made both of those look like a machine on 22.
    it("reads the port out of every place one can be declared", () => {
        expect(script).toContain('tolower($1) == "listenaddress" && match(_value, /:[0-9]+$/)');
        expect(script).toContain('if (tolower(_key) != "listenstream") next');
        // What `systemctl edit ssh.socket` actually writes.
        expect(script).toContain("/etc/systemd/system/ssh.socket.d/*.conf");
        expect(script).toContain("/lib/systemd/system/ssh.socket");
        // A bare IPv6 literal is colons and no port; only the bracketed form or an
        // address with no other colon in it carries one.
        expect(script).toContain("_addr ~ /^\\[.*\\]$/ || _addr !~ /:/");
        // A reading that is not a port number never becomes a candidate.
        expect(script).toContain("''|*[!0-9]*) continue ;;");
    });

    // sshd_config permits quoting a directive's value, and a quote left on it is
    // neither a number nor a path that resolves: `Include "sshd_config.d/*.conf"`
    // globbed against a pattern with the quotes still in it, matched nothing, and
    // silently dropped the files a hardened port usually lives in.
    it("reads a directive whose value is quoted, which sshd_config allows", () => {
        expect(script).toContain('_value = $i; gsub(/"/, "", _value)');
        expect(script).toContain('{ _value = $2; gsub(/"/, "", _value) }');
        // The socket unit strips them in the same pass as its whitespace.
        expect(script).toContain('gsub(/[ \\t\\r"]/, "", _value)');
    });

    // The parse is the fallback, not the answer. This runs as root, so the process
    // holding a socket is readable, and sshd's own socket settles the port without
    // caring where it was written down - which is what makes a config shape nobody
    // anticipated stop being a machine that cannot enroll.
    it("prefers the port sshd is observed on over anything the config says", () => {
        const probe = script.slice(script.indexOf("SSH_PROBE=none"));
        expect(probe).toContain('"$LISTENERS_OWNED" | reachable_listener "" sshd)');
        // The candidate sweep is the else, so it only runs when the owner was mute.
        expect(probe.indexOf('if [ -n "$OBSERVED_PORT" ]')).toBeLessThan(probe.indexOf("for port in $SSH_PORTS; do"));
        expect(probe).toContain("SSH_PORT=$OBSERVED_PORT");
    });

    // `set -e` is on, so an assignment from a pipeline that exits non-zero takes the
    // script down where it stands - before the claim, without reaching `die`, and
    // therefore without telling Polaris anything. An awk that is not on root's PATH
    // is enough to do it, and the dialog would go back to waiting the command out
    // and blaming the clock.
    it("cannot be killed by the listener probe itself failing", () => {
        const probe = script.slice(script.indexOf("SSH_PROBE=none"));
        const observed = probe.slice(probe.indexOf("OBSERVED_PORT="));
        expect(observed.slice(0, observed.indexOf("\n"))).toContain('|| OBSERVED_PORT=""');
        // The two candidate sweeps read their tables inside an `if`, where a
        // non-zero status is the condition rather than a fatal error.
        expect(probe).toContain('if [ -n "$OBSERVED_PORT" ]');
        expect(probe).toContain('if owned_by "$port" systemd');
    });

    // An observed listener beats a parse. This is also what makes the port Polaris
    // dials right on a box where the parse was wrong but nothing was ever broken.
    it("lets the port sshd is actually on win, and refuses only if nothing is there", () => {
        const probe = script.slice(script.indexOf("SSH_PROBE=none"));
        expect(probe).toContain("for port in $SSH_PORTS; do");
        expect(probe).toContain("SSH_PORT=$port");
        expect(probe).toContain("SSH_LISTENING=yes");
        // The refusal is outside the loops: it needs every candidate to have missed.
        expect(probe.indexOf("die ssh-not-listening")).toBeGreaterThan(probe.lastIndexOf("SSH_LISTENING=yes"));
    });

    // Before this, the pre-claim abort existed only in a terminal nobody was
    // necessarily watching: the dialog span for the full lifetime and then said the
    // command had expired, which by then was a lie about what happened.
    //
    // Every abort in this script is a pre-claim one, so reporting lives inside
    // `die` rather than being a call to remember at each of them - which is what
    // makes "no silent stop" a property of the script instead of a habit.
    it("cannot stop without telling Polaris why", () => {
        expect(script).toContain("/refuse");
        // No bare `die "message"` anywhere: a code is not optional.
        expect(script).not.toMatch(/die "/);
        const codes = [...script.matchAll(/(?:^|[|;&\s])die ([a-z-]+) "/gm)].map((match) => match[1]);
        expect(codes.length).toBeGreaterThan(0);
        for (const code of codes) expect(ENROLLMENT_REFUSAL_REASONS).toContain(code);
        // Nothing the script can refuse over is missing a sentence Polaris owns.
        for (const reason of ENROLLMENT_REFUSAL_REASONS) {
            expect(ENROLLMENT_REFUSAL_MESSAGES[reason].length).toBeGreaterThan(0);
        }
        // The ones this change was built for, plus the aborts that used to be mute.
        expect(codes).toEqual(
            expect.arrayContaining([
                "ssh-not-listening",
                "remote-login-off",
                "ssh-access-list-unrestricted",
                "remote-login-unrestricted",
                "remote-login-left-open",
                "ssh-access-list-left-behind",
                "not-in-ssh-access-list",
                "no-ssh-host-keys",
                "no-home-directory",
                "no-user-tooling",
                "unsupported-platform",
                "curl-missing",
                "unknown-option",
                "not-root"
            ])
        );
    });

    // Scanning for `die "` was how the argument parser's bare `exit 2` sat there
    // being a silent pre-claim stop while a test claimed there were none. The
    // property is about stopping, not about a spelling, so this looks for the act:
    // every shell exit before the claim, and every word said to stderr on the way
    // out, has to be `die`'s - which is also why `die` is defined above the parser.
    it("routes every pre-claim stop through die, whatever it is spelled like", () => {
        const preClaim = script.slice(0, script.indexOf('say "telling Polaris about this machine'));
        const die = preClaim.slice(preClaim.indexOf("die() {"));
        const body = die.slice(0, die.indexOf("\n}"));
        // awk's own `exit` carries no status, so a numbered one is always the shell.
        const stops = preClaim.split("\n").filter((line) => /\bexit [0-9]/.test(line) || />&2/.test(line));
        expect(stops.length).toBeGreaterThan(0);
        for (const stop of stops) expect(body).toContain(stop.trim());
        expect(preClaim).not.toContain("exit 2");
        expect(script).toContain('*) die unknown-option "unknown option $arg" ;;');
        // Nothing can stop before the reporter exists.
        expect(preClaim.indexOf("die() {")).toBeLessThan(preClaim.indexOf('for arg in "$@"'));
    });

    // `die curl-missing` reported itself with curl, so the one abort that fires
    // because curl is not there was the one abort that could never be delivered -
    // and the dialog went back to waiting the command out and blaming the clock.
    it("can still deliver the refusal that fires because curl is missing", () => {
        const die = script.slice(script.indexOf("die() {"));
        const body = die.slice(0, die.indexOf("\n}"));
        expect(body).toContain("elif command -v wget");
        expect(body).toContain("--post-data=");
        expect(body).toContain("--timeout=10");
        // Still a code and never a sentence, whichever tool carries it.
        expect(body.match(/printf '\{"reason":"%s"\}' "\$1"/g)).toHaveLength(2);
        // Still best-effort: neither branch may change the exit or the message.
        expect(body.match(/\|\| true/g)).toHaveLength(2);
        expect(body.indexOf("/refuse")).toBeLessThan(body.indexOf('echo "polaris: $2"'));
    });

    // A refusal is a courtesy to the dialog, not a step of the enrollment. If it
    // cannot be delivered the script must still print what it printed and exit how
    // it exits, so nothing about it is allowed to fail loudly.
    it("reports the refusal best-effort, so a failure changes nothing", () => {
        const helper = script.slice(script.indexOf("die() {"));
        const body = helper.slice(0, helper.indexOf("\n}"));
        expect(body).toContain("|| true");
        expect(body).toContain("--max-time");
        // A code, never a sentence: this endpoint is unauthenticated.
        expect(body).toContain("printf '{\"reason\":\"%s\"}' \"$1\"");
        // Reported before the operator is told, and the exit code is still 1.
        expect(body.indexOf("/refuse")).toBeLessThan(body.indexOf('echo "polaris: $2"'));
        expect(body).toContain("exit 1");
    });

    // Both die messages used to say "then run this command again" flatly, and the
    // command can be most of the way through its life by the time somebody has
    // installed an SSH server - so the next thing they saw was "expired".
    it("does not promise a re-run the command may be too old for", () => {
        expect(script).not.toContain("then run this command again\"");
        const dies =
            script.match(
                /die (?:ssh-not-listening|remote-login-off|ssh-access-list-unrestricted|remote-login-unrestricted|remote-login-left-open|ssh-access-list-left-behind|not-in-ssh-access-list) "[^"]*"/g
            ) ?? [];
        expect(dies).toHaveLength(10);
        for (const message of dies) expect(message).toContain("$POLARIS_RETRY_HINT");
    });

    // The hint is prose from @polaris/core spliced into a script that gets piped
    // into a root shell. Every other value the script carries is single-quoted on
    // the way in, and a later edit adding a quote, a `$` or a backtick to it must
    // not be the thing that decides whether the script parses.
    it("quotes the retry hint on the way in like every other value", () => {
        expect(script).toContain(`POLARIS_RETRY_HINT='${ENROLLMENT_RETRY_HINT}'`);
        // Once, in that quoted assignment, and nowhere else: every message reaches
        // it through the variable rather than carrying a copy of the prose.
        expect(script.split(ENROLLMENT_RETRY_HINT)).toHaveLength(2);
    });

    it("locks the login it creates out of password authentication", () => {
        expect(script).toContain('passwd -l "$POLARIS_USER"');
    });

    it("posts back to the claim endpoint for this token only", () => {
        expect(script).toContain("$POLARIS_URL/api/servers/enroll/$POLARIS_TOKEN/claim");
    });

    it("quotes every value it interpolates", () => {
        const injected = enrollmentScript({
            baseUrl: "https://polaris.example.com",
            token: "tok';rm -rf /;'",
            username: "polaris",
            publicKey: "ssh-ed25519 AAAA x"
        });
        // The closing quote is escaped rather than ending the assignment, so the
        // payload stays one string instead of becoming a second command.
        expect(injected).toContain("POLARIS_TOKEN='tok'\\'';rm -rf /;'\\'''");
    });
});
