/**
 * Enrollment is the one path where Polaris acts on what an unauthenticated
 * machine tells it, so the two decisions that bound the damage are pinned here:
 * which address it believes, and what the script it hands out actually contains.
 */

import { describe, expect, it } from "vitest";
import { pickEnrollmentAddress } from "@polaris/core";
import { enrollmentCommand, enrollmentScript } from "../../src/lib/enrollment-script";

describe("pickEnrollmentAddress", () => {
    it("believes the address it observed over the one it was told", () => {
        expect(pickEnrollmentAddress("203.0.113.8", ["10.0.0.5", "192.168.1.7"])).toBe("203.0.113.8");
    });

    it("falls back to a reported address when nothing was observed", () => {
        expect(pickEnrollmentAddress(undefined, ["192.168.1.7"])).toBe("192.168.1.7");
    });

    it("never accepts loopback, which is Polaris's own proxy and not the machine", () => {
        expect(pickEnrollmentAddress("127.0.0.1", ["192.168.1.7"])).toBe("192.168.1.7");
        expect(pickEnrollmentAddress("::1", ["192.168.1.7"])).toBe("192.168.1.7");
        expect(pickEnrollmentAddress("127.0.0.1", ["127.0.0.1", "localhost"])).toBeNull();
    });

    it("has nothing to offer when the machine reported nothing usable", () => {
        expect(pickEnrollmentAddress(undefined, [])).toBeNull();
        expect(pickEnrollmentAddress("", ["  "])).toBeNull();
    });
});

describe("enrollmentCommand", () => {
    it("stays a plain pipe into sh so it runs on a minimal box", () => {
        expect(enrollmentCommand("https://polaris.example.com", "tok")).toBe(
            "curl -fsSL https://polaris.example.com/api/servers/enroll/tok | sudo sh"
        );
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
