import { describe, expect, it } from "vitest";
import * as model from "@polaris-app/security-scans/src/model/ssh";
import * as specs from "@polaris-app/security-scans/src/model/specs";

// What the status script printed on a Debian server with one key account,
// root with a password, and one person with only a password.
const STATUS = [
    "POLARIS_DISTRO id=debian",
    "POLARIS_SSH=off",
    "POLARIS_SSHD=passwordauthentication yes",
    "POLARIS_SSHD=permitrootlogin yes",
    "POLARIS_SSHD=pubkeyauthentication yes",
    "POLARIS_SSHD=kbdinteractiveauthentication no",
    "POLARIS_ACCOUNT=root 0 yes",
    "POLARIS_ACCOUNT=polaris 1 no",
    "POLARIS_ACCOUNT=bob 0 yes",
    "POLARIS_ACCOUNT=bad;name 1 no"
].join("\n");

describe("SSH hardening", () => {
    it("reads what sshd accepts and who has a key", () => {
        const report = model.parseSshLog(STATUS);
        expect(report).toEqual({
            state: "off",
            passwordLogin: true,
            rootLogin: "yes",
            accounts: [
                { name: "root", keys: 0, password: true },
                { name: "polaris", keys: 1, password: false },
                { name: "bob", keys: 0, password: true }
            ]
        });
        expect(model.parseSshLog("POLARIS_DISTRO id=debian")).toBeNull();
    });

    it("counts a keyboard-interactive prompt as a password", () => {
        const report = model.parseSshLog(
            [
                "POLARIS_SSH=off",
                "POLARIS_SSHD=passwordauthentication no",
                "POLARIS_SSHD=kbdinteractiveauthentication yes",
                "POLARIS_SSHD=permitrootlogin without-password"
            ].join("\n")
        );
        expect(report?.passwordLogin).toBe(true);
        expect(model.planSsh(report!, { local: true, polarisAuth: null }).hardened).toBe(false);
    });

    it("lists who keeps signing in and who stops", () => {
        const plan = model.planSsh(model.parseSshLog(STATUS)!, { local: false, polarisAuth: "key" });
        expect(plan).toEqual({
            blocked: null,
            hardened: false,
            keyed: ["polaris"],
            loses: ["root", "bob"]
        });
    });

    it("refuses when Polaris itself signs in with a password, or nobody has a key", () => {
        const report = model.parseSshLog(STATUS)!;
        expect(model.planSsh(report, { local: false, polarisAuth: "password" }).blocked).toBe(
            "passwordLogin"
        );
        const nobody = model.parseSshLog(
            ["POLARIS_SSH=off", "POLARIS_ACCOUNT=root 0 yes"].join("\n")
        )!;
        expect(model.planSsh(nobody, { local: true, polarisAuth: null }).blocked).toBe("noKeys");
        const none = model.parseSshLog("POLARIS_SSH=unavailable")!;
        expect(model.planSsh(none, { local: true, polarisAuth: null }).blocked).toBe("unavailable");
    });

    it("tells the owner once, and never when already key-only or a person chose", () => {
        const view = {
            state: "off" as const,
            plan: model.planSsh(model.parseSshLog(STATUS)!, { local: false, polarisAuth: "key" })
        };
        expect(model.sshStep(null, view)).toBe("review");
        expect(model.sshStep({ sshChoice: null, sshNotifiedAt: new Date() }, view)).toBeNull();
        expect(model.sshStep({ sshChoice: "off", sshNotifiedAt: null }, view)).toBeNull();
        expect(model.sshStep(null, { ...view, state: "on" })).toBeNull();
        expect(
            model.sshStep(null, { ...view, plan: { ...view.plan, hardened: true } })
        ).toBeNull();
        expect(
            model.sshStep(null, { ...view, plan: { ...view.plan, blocked: "noKeys" } })
        ).toBeNull();
    });

    it("reads how an apply or confirm ended", () => {
        expect(model.parseSshEnding("POLARIS_DISTRO id=debian\nPOLARIS_SSH=armed")).toBe("armed");
        expect(model.parseSshEnding("POLARIS_SSH=overridden")).toBe("overridden");
        expect(model.parseSshEnding("POLARIS_SSH=whatever")).toBeNull();
    });

    it("passes the change id as the script's own word", () => {
        const argv = specs.hostArgv("ssh-apply", ["0f8c2a4e-1b2c"]);
        expect(argv.slice(-3)).toEqual([specs.UPDATES_SCRIPTS["ssh-apply"], "polaris", "0f8c2a4e-1b2c"]);
        expect(argv).toContain("--privileged");
    });
});
