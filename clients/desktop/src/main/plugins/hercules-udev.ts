/**
 * Linux: the udev rule that lets the signed-in user open the Hercules Stream
 * 100 over USB, the Linux side of "Polaris driver on this PC". Both of the
 * controller's interfaces are vendor-specific, so no kernel driver binds them
 * and nothing has to be replaced: the only thing missing on a stock system is
 * permission to open `/dev/bus/usb/...` as a normal user.
 *
 * The rule tags the device `uaccess`, so systemd-logind gives whoever sits at
 * the seat an ACL on it (the same rule cont1nuity/hercules-stream-linux ships
 * in `99-hercules-stream.rules`). It must sort before `73-seat-late.rules`,
 * where udev turns the tag into the ACL, hence `70-`; MODE/GROUP stay as the
 * fallback for systems without logind.
 *
 * The manifest lists it under `requires` for linux-x64 and linux-arm64, so it
 * is set up like the Windows driver (`requirements.ts`): consented to with the
 * install, put back by itself when it goes missing, offered on the page when
 * it was never consented to or the prompt was declined. Installing and
 * removing take one polkit prompt each (`pkexec`), the Linux counterpart of
 * the Windows elevation prompt. The elevated shell runs a fixed script; the
 * rule reaches it as an argument, never spliced into the script.
 */
import type { OfficialHost } from "./hercules-official-run";
import type { RequirementLook, RequirementRunner } from "./requirements";
import type { DriverFailure, DriverOutcome } from "./hercules-driver";

export const RULE_PATH = "/etc/udev/rules.d/70-polaris-stream100.rules";

export const RULE = [
    "# Polaris: lets the signed-in user open the Hercules Stream 100 (06f8:e053).",
    "# Installed and removed from the Stream 100 plugin in the Polaris desktop app.",
    'SUBSYSTEM=="usb", ATTR{idVendor}=="06f8", ATTR{idProduct}=="e053", TAG+="uaccess", MODE="0660", GROUP="plugdev"',
    ""
].join("\n");

const PKEXEC = "/usr/bin/pkexec";
const SH = "/bin/sh";

/** Reload the rules and replay "add" for the controller, so one already plugged in gets its ACL now. */
const APPLY = "udevadm control --reload-rules && udevadm trigger --action=add --subsystem-match=usb --attr-match=idVendor=06f8 --attr-match=idProduct=e053";

/** The fixed script the elevated shell runs; `$1` is the rule text. */
export const INSTALL_SCRIPT = `umask 022 && printf '%s' "$1" > ${RULE_PATH}.tmp && mv -f ${RULE_PATH}.tmp ${RULE_PATH} && ${APPLY}`;
export const REMOVE_SCRIPT = `rm -f ${RULE_PATH} && ${APPLY}`;

/** pkexec's own exit codes: 126 the prompt was dismissed or refused, 127 not authorized. */
export function udevFailureOf(code: number): DriverFailure | null {
    if (code === 0) return null;
    if (code === 126 || code === 127) return "declined";
    return "failed";
}

/** Met with Polaris' rule in place; missing without it, or with its text changed (then it was set up before). The device's presence does not matter. */
export function decideUdev(current: string | null): RequirementLook {
    if (current === null) return { state: "missing", before: false };
    return { state: current === RULE ? "met" : "missing", before: true };
}

export function createUdevRunner(host: OfficialHost) {
    async function elevate(args: readonly string[]): Promise<DriverOutcome> {
        const out = await host.run(PKEXEC, args);
        const reason = udevFailureOf(out.code);
        return reason ? { ok: false, reason } : { ok: true };
    }

    return {
        state: async (): Promise<RequirementLook> => decideUdev(await host.readText(RULE_PATH, 16 * 1024)),
        /** The rule is on this machine (whatever its text). */
        installed: async () => (await host.readText(RULE_PATH, 16 * 1024)) !== null,
        install: () => elevate([SH, "-c", INSTALL_SCRIPT, "sh", RULE]),
        remove: () => elevate([SH, "-c", REMOVE_SCRIPT])
    };
}

export type UdevRunner = ReturnType<typeof createUdevRunner>;

/** The rule as a manifest requirement (`requires`, key `udevRule`). */
export function udevRequirement(udev: UdevRunner): RequirementRunner {
    return { look: () => udev.state(), setUp: () => udev.install() };
}
