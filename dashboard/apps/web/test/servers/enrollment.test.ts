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
            "curl -sSL https://polaris.example.com/api/servers/enroll/tok | sudo sh"
        );
    });

    // A spent or unknown token is answered with a script that says so and exits 1.
    // `-f` discards that body, leaving the operator with `curl: (22) ... 404` and a
    // pipeline that exits 0 - the command looks like it worked and nothing arrives.
    it("does not throw away the body a refusal explains itself in", () => {
        expect(enrollmentCommand("https://polaris.example.com", "tok")).not.toContain("-f");
        expect(enrollmentCommand("https://polaris.example.com", "tok", true, true)).not.toContain("-f");
    });

    it("keeps container access visible as an argument rather than hiding it", () => {
        expect(enrollmentCommand("https://polaris.example.com", "tok", true)).toContain("-- --docker");
    });

    // Both are root on the machine in practice, so neither is ever conceded by a
    // command that does not say so on its face.
    it("keeps root visible too, alongside or without container access", () => {
        expect(enrollmentCommand("https://polaris.example.com", "tok", false, true)).toContain("-- --root");
        expect(enrollmentCommand("https://polaris.example.com", "tok", true, true)).toContain("-- --docker --root");
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
        expect(script).toContain('[ "$(id -u)" = "0" ] || die "run this with sudo"');
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
            script.indexOf("systemsetup -setremotelogin on"),
            script.indexOf("turned Remote Login on")
        );
        expect(enabled).toContain("dseditgroup -o create -q com.apple.access_ssh");
        expect(enabled).toContain("dseditgroup -o edit -d everyone -t group com.apple.access_ssh");
        expect(enabled).toContain('dseditgroup -o edit -a "$POLARIS_USER" -t user com.apple.access_ssh');

        // The already-on path adds and never removes.
        const alreadyOn = script.slice(script.indexOf('if [ "$REMOTE_LOGIN" = "unknown" ]'));
        const untilEnd = alreadyOn.slice(0, alreadyOn.indexOf("SSH_PROBE"));
        expect(untilEnd).toContain('dseditgroup -o edit -a "$POLARIS_USER"');
        expect(untilEnd).not.toContain("-d everyone");
        expect(untilEnd).not.toContain("-o create");
    });

    it("says how to undo the Remote Login changes it can make", () => {
        expect(script).toContain("sudo systemsetup -setremotelogin off");
        expect(script).toContain("sudo dseditgroup -o delete com.apple.access_ssh");
    });

    // Stopping here leaves the token unspent, so the same command works again once
    // the SSH server is on. Claiming first would burn it for nothing.
    it("stops before the claim when nothing will answer on the SSH port", () => {
        const preflight = script.indexOf("nothing is listening on any port");
        expect(preflight).toBeGreaterThan(-1);
        expect(preflight).toBeLessThan(script.indexOf("telling Polaris about this machine"));
        expect(script).toContain('die "Remote Login is off');
    });

    // A box with neither tool cannot answer the question, and a wrong "nothing is
    // listening" would strand an enrollment that was fine.
    it("only refuses on a listener check it could actually run", () => {
        expect(script).toContain("SSH_PROBE=none");
        expect(script).toContain('if [ "$SSH_PROBE" = "none" ]');
        expect(script).toContain('if [ "$SSH_LISTENING" = "no" ]');
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

    // An observed listener beats a parse. This is also what makes the port Polaris
    // dials right on a box where the parse was wrong but nothing was ever broken.
    it("lets the port that actually has a listener win, and refuses only if none does", () => {
        const probe = script.slice(script.indexOf("SSH_PROBE=none"));
        expect(probe).toContain("for port in $SSH_PORTS; do");
        expect(probe).toContain("SSH_PORT=$port");
        expect(probe).toContain("SSH_LISTENING=yes");
        // The refusal is outside the loop: it needs every candidate to have missed.
        expect(probe.indexOf('if [ "$SSH_LISTENING" = "no" ]')).toBeGreaterThan(probe.indexOf("SSH_LISTENING=yes"));
    });

    // Before this, the pre-claim abort existed only in a terminal nobody was
    // necessarily watching: the dialog span for the full lifetime and then said the
    // command had expired, which by then was a lie about what happened.
    it("tells Polaris why it stopped, before each pre-claim die", () => {
        expect(script).toContain("/refuse");
        for (const reason of ENROLLMENT_REFUSAL_REASONS) expect(script).toContain(`refuse ${reason}`);
        // Reported first, so the dialog has the reason before the operator is told.
        expect(script.indexOf("refuse ssh-not-listening")).toBeLessThan(
            script.indexOf('die "nothing is listening on any port')
        );
        expect(script.indexOf("refuse remote-login-off")).toBeLessThan(script.indexOf('die "Remote Login is off'));
    });

    // A refusal is a courtesy to the dialog, not a step of the enrollment. If it
    // cannot be delivered the script must still print what it printed and exit how
    // it exits, so nothing about it is allowed to fail loudly.
    it("reports the refusal best-effort, so a failure changes nothing", () => {
        const helper = script.slice(script.indexOf("refuse() {"));
        const body = helper.slice(0, helper.indexOf("\n}"));
        expect(body).toContain("|| true");
        expect(body).toContain("--max-time");
        // A code, never a sentence: this endpoint is unauthenticated.
        expect(body).toContain("printf '{\"reason\":\"%s\"}' \"$1\"");
    });

    // Both die messages used to say "then run this command again" flatly, and the
    // command can be most of the way through its life by the time somebody has
    // installed an SSH server - so the next thing they saw was "expired".
    it("does not promise a re-run the command may be too old for", () => {
        expect(script).not.toContain("then run this command again\"");
        const dies = script.match(/die "(?:nothing is listening|Remote Login is off)[^"]*"/g) ?? [];
        expect(dies).toHaveLength(2);
        for (const message of dies) expect(message).toContain(ENROLLMENT_RETRY_HINT);
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
