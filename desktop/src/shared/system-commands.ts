/**
 * What each of the launcher's system commands (`@polaris/core`
 * `launcher-commands`) runs on each system: a program and its arguments, run
 * with no shell. A command a system has no dependable way to do is left out,
 * so the launcher never lists it there: macOS has no lock it can trigger
 * without Accessibility, and a Linux session without `XDG_SESSION_ID` cannot be
 * told which session to end.
 *
 * Windows programs are named by their full path under `SystemRoot`, never
 * looked up on `PATH`. Pure, so every system's table is tested on any.
 */

import { win32 } from "node:path";
import { launcherCommandsFor, type LauncherCommand } from "../../../dashboard/packages/core/src/launcher-commands";

export interface SystemCommand extends LauncherCommand {
    readonly file: string;
    readonly args: readonly string[];
}

type Plan = Partial<Record<LauncherCommand["id"], { file: string; args: readonly string[]; label?: string; }>>;

function windowsPlan(env: NodeJS.ProcessEnv): Plan {
    const system = win32.join(env.SystemRoot || env.windir || "C:\\Windows", "System32");
    const rundll = win32.join(system, "rundll32.exe");
    const shutdown = win32.join(system, "shutdown.exe");
    const powershell = win32.join(system, "WindowsPowerShell", "v1.0", "powershell.exe");
    const ps = (script: string) => ({ file: powershell, args: ["-NoProfile", "-NonInteractive", "-Command", script] });
    return {
        lock: { file: rundll, args: ["user32.dll,LockWorkStation"] },
        // `SetSuspendState` through rundll32 hibernates when hibernation is on; this asks for sleep.
        sleep: ps("Add-Type -AssemblyName System.Windows.Forms; [void][System.Windows.Forms.Application]::SetSuspendState('Suspend', $false, $false)"),
        restart: { file: shutdown, args: ["/r", "/t", "0"] },
        shutdown: { file: shutdown, args: ["/s", "/t", "0"] },
        logout: { file: shutdown, args: ["/l"] },
        "empty-trash": { ...ps("Clear-RecycleBin -Force -ErrorAction SilentlyContinue"), label: "Empty Recycle Bin" }
    };
}

function macPlan(): Plan {
    const events = (verb: string) => ({ file: "/usr/bin/osascript", args: ["-e", `tell application "System Events" to ${verb}`] });
    return {
        sleep: { file: "/usr/bin/pmset", args: ["sleepnow"] },
        restart: events("restart"),
        shutdown: events("shut down"),
        logout: events("log out"),
        "empty-trash": { file: "/usr/bin/osascript", args: ["-e", 'tell application "Finder" to empty trash'], label: "Empty Trash" }
    };
}

function linuxPlan(env: NodeJS.ProcessEnv): Plan {
    const session = env.XDG_SESSION_ID?.trim();
    return {
        lock: { file: "loginctl", args: ["lock-session"] },
        sleep: { file: "systemctl", args: ["suspend"] },
        restart: { file: "systemctl", args: ["reboot"] },
        shutdown: { file: "systemctl", args: ["poweroff"] },
        ...(session && /^[\w-]{1,64}$/.test(session) ? { logout: { file: "loginctl", args: ["terminate-session", session] } } : {}),
        "empty-trash": { file: "gio", args: ["trash", "--empty"], label: "Empty Trash" }
    };
}

/** The system commands this computer can run, in the registry's order. */
export function systemCommands(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): SystemCommand[] {
    const plan = platform === "win32" ? windowsPlan(env) : platform === "darwin" ? macPlan() : platform === "linux" ? linuxPlan(env) : {};
    return launcherCommandsFor("desktop").flatMap((command) => {
        const run = plan[command.id];
        return run ? [{ ...command, label: run.label ?? command.label, file: run.file, args: run.args }] : [];
    });
}

/** A command as something the launcher's search finds: its name, and its other words as context. */
export function searchableCommand(command: SystemCommand): { label: string; context: string; } {
    return { label: command.label, context: command.words.join(" ") };
}
