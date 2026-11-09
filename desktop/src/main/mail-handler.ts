/**
 * Put Polaris on Windows' list of apps that can open `mailto:` links.
 *
 * Windows only offers an app in Settings > Default apps (and in the "How do you
 * want to open this?" picker) when it is registered as a *registered
 * application*: a `Capabilities` key naming the link types it handles, a
 * `RegisteredApplications` entry pointing at it, and a ProgID with the command
 * to run. `app.setAsDefaultProtocolClient("mailto")` writes none of those - it
 * claims `HKCU\Software\Classes\mailto`, which Windows ignores in favour of the
 * person's own choice - so Polaris never appeared there.
 *
 * This only makes Polaris one of the choices. Which app opens a link stays the
 * person's to pick, which Windows enforces anyway. Everything is under HKCU, so
 * no elevation is needed, and it is written again on every start because the
 * executable's folder changes with each version.
 */

import { spawn } from "node:child_process";

const PROG_ID = "Polaris.Url.mailto";
const CAPABILITIES = "Software\\Polaris\\Capabilities";
const ROOT = "HKCU\\Software";

/** One `reg.exe` call: the key, then its arguments. */
export type RegCommand = readonly string[];

/** The `reg add` calls that register `exe` as a mailto handler. Pure, for the tests. */
export function mailHandlerCommands(exe: string): RegCommand[] {
    const progId = `${ROOT}\\Classes\\${PROG_ID}`;
    const add = (key: string, name: string | null, value: string): RegCommand => [
        "add",
        key,
        ...(name === null ? ["/ve"] : ["/v", name]),
        "/t",
        "REG_SZ",
        "/d",
        value,
        "/f"
    ];
    return [
        add(progId, null, "Polaris mail link"),
        add(progId, "URL Protocol", ""),
        add(`${progId}\\DefaultIcon`, null, `"${exe}",0`),
        add(`${progId}\\shell\\open\\command`, null, `"${exe}" "%1"`),
        add(`HKCU\\${CAPABILITIES}`, "ApplicationName", "Polaris"),
        add(`HKCU\\${CAPABILITIES}`, "ApplicationDescription", "Mail, chat and everything else on your Polaris."),
        add(`HKCU\\${CAPABILITIES}\\URLAssociations`, "mailto", PROG_ID),
        add(`${ROOT}\\RegisteredApplications`, "Polaris", CAPABILITIES)
    ];
}

/** The `reg delete` calls that take it all back off, for the uninstaller. */
export function mailHandlerRemovals(): RegCommand[] {
    return [
        ["delete", `${ROOT}\\RegisteredApplications`, "/v", "Polaris", "/f"],
        ["delete", `${ROOT}\\Polaris`, "/f"],
        ["delete", `${ROOT}\\Classes\\${PROG_ID}`, "/f"]
    ];
}

/** Run the calls one after another; a failure is logged, never thrown, since a
 *  missing entry on the list must not stop the app from opening. */
export function runReg(commands: readonly RegCommand[]): Promise<void> {
    return commands.reduce<Promise<void>>(
        (previous, args) =>
            previous.then(
                () =>
                    new Promise<void>((resolve) => {
                        try {
                            const child = spawn("reg.exe", [...args], { windowsHide: true, stdio: "ignore" });
                            child.on("error", () => resolve());
                            child.on("close", () => resolve());
                        } catch {
                            resolve();
                        }
                    })
            ),
        Promise.resolve()
    );
}

/** Register `exe` as one of the apps that can open mailto links. Windows only. */
export function registerMailHandler(exe: string): Promise<void> {
    if (process.platform !== "win32") return Promise.resolve();
    return runReg(mailHandlerCommands(exe));
}

/** Take Polaris off that list. Windows only. */
export function unregisterMailHandler(): Promise<void> {
    if (process.platform !== "win32") return Promise.resolve();
    return runReg(mailHandlerRemovals());
}
