/**
 * Opening with the computer.
 *
 * On Windows a per-user Task Scheduler task with a logon trigger opens the app, and
 * the Run key is only its fallback. Windows gives "no guarantees about how promptly
 * the programs in the Run key are run" (Microsoft Learn, "Run and RunOnce Registry
 * Keys"), and Explorer holds them back on a busy sign-in (`Explorer\Serialize`,
 * `StartupDelayInMSec`): Polaris was seen opening six minutes after one. A logon
 * task is started by the Task Scheduler service at sign-in, outside that queue.
 * Both name Squirrel's launcher, since the app's own folder changes with every version.
 *
 * macOS keeps its own login items. Linux has no system call for it: a desktop file in
 * the autostart folder is what every desktop reads.
 */

import { app } from "electron";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir, userInfo } from "node:os";
import { basename, dirname, join } from "node:path";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";

const NAME = "Polaris";

/** On the command line of a start the computer made, so the app can tell it
 *  apart from somebody opening it. */
export const LOGIN_ARG = "--hidden";

/** How long `schtasks` may take before it counts as having failed. */
const SCHEDULER_TIMEOUT_MS = 15_000;

/** Whether this run was started by signing in to the computer. */
export function startedAtLogin(argv: readonly string[]): boolean {
    if (argv.includes(LOGIN_ARG)) return true;
    if (process.platform !== "darwin") return false;
    try {
        return app.getLoginItemSettings().wasOpenedAtLogin === true;
    } catch {
        return false;
    }
}

function linuxEntry(): string {
    return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "autostart", "polaris.desktop");
}

function setLinux(open: boolean): void {
    const entry = linuxEntry();
    if (!open) return rmSync(entry, { force: true });
    mkdirSync(dirname(entry), { recursive: true });
    const command = process.env.APPIMAGE ?? process.execPath;
    writeFileSync(
        entry,
        `[Desktop Entry]\nType=Application\nName=${NAME}\nExec="${command.replace(/(["\\$`])/g, "\\$1")}" ${LOGIN_ARG}\nX-GNOME-Autostart-enabled=true\n`
    );
}

/** Squirrel's launcher and what it is told to start, the same for the task and the Run key. */
function launcher(): { readonly path: string; readonly args: readonly string[]; } {
    return {
        path: join(dirname(process.execPath), "..", "Update.exe"),
        args: ["--processStart", basename(process.execPath), "--process-start-args", LOGIN_ARG]
    };
}

/** The Run key entry, kept only while the logon task cannot be. */
function setRunEntry(open: boolean): void {
    const { path, args } = launcher();
    app.setLoginItemSettings({ name: NAME, openAtLogin: open, path, args: [...args] });
}

/** This Windows account, as the task's trigger and principal name it. */
function account(): { readonly user: string; readonly id: string; } {
    const user = userInfo().username;
    const domain = process.env.USERDOMAIN;
    return { user, id: domain ? `${domain}\\${user}` : user };
}

/** One task per Windows account: task names are shared by everyone on the computer. */
export function logonTaskName(user: string): string {
    return `${NAME} at sign-in (${user.replace(/[\\/:*?"<>|]/g, "_")})`;
}

function xmlText(value: string): string {
    return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/**
 * The logon task as Task Scheduler's XML. Pure, for the tests. Limited rights, the
 * signed-in user's own session, no delay, no time limit and normal priority: a
 * task's default (7) is below normal, and the app would inherit it.
 */
export function logonTaskXml(userId: string, command: string, args: readonly string[]): string {
    const user = xmlText(userId);
    const argLine = args.map((arg) => `"${arg}"`).join(" ");
    return [
        `<?xml version="1.0" encoding="UTF-16"?>`,
        `<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">`,
        `  <RegistrationInfo><Description>Opens ${NAME} when you sign in.</Description></RegistrationInfo>`,
        `  <Triggers><LogonTrigger><Enabled>true</Enabled><UserId>${user}</UserId></LogonTrigger></Triggers>`,
        `  <Principals><Principal id="Author"><UserId>${user}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>`,
        "  <Settings>",
        "    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>",
        "    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>",
        "    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>",
        "    <AllowHardTerminate>true</AllowHardTerminate>",
        "    <StartWhenAvailable>false</StartWhenAvailable>",
        "    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>",
        "    <IdleSettings><StopOnIdleEnd>false</StopOnIdleEnd><RestartOnIdle>false</RestartOnIdle></IdleSettings>",
        "    <AllowStartOnDemand>true</AllowStartOnDemand>",
        "    <Enabled>true</Enabled>",
        "    <Hidden>false</Hidden>",
        "    <RunOnlyIfIdle>false</RunOnlyIfIdle>",
        "    <WakeToRun>false</WakeToRun>",
        "    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>",
        "    <Priority>5</Priority>",
        "  </Settings>",
        `  <Actions Context="Author"><Exec><Command>${xmlText(command)}</Command><Arguments>${xmlText(argLine)}</Arguments></Exec></Actions>`,
        "</Task>",
        ""
    ].join("\r\n");
}

/** Runs `schtasks.exe` with an argument array and no shell; true when it exited 0. */
function schtasks(args: readonly string[]): Promise<boolean> {
    const exe = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "schtasks.exe");
    return new Promise((resolve) => {
        try {
            execFile(exe, [...args], { windowsHide: true, timeout: SCHEDULER_TIMEOUT_MS }, (error) => resolve(!error));
        } catch {
            resolve(false);
        }
    });
}

/** Writes the task, replacing one already there; false when Windows refused it. */
async function registerLogonTask(): Promise<boolean> {
    const { user, id } = account();
    const { path, args } = launcher();
    // schtasks reads its XML from a file, in UTF-16 with a byte order mark.
    const file = join(tmpdir(), `polaris-logon-${randomUUID()}.xml`);
    try {
        await writeFile(file, Buffer.from(`\ufeff${logonTaskXml(id, path, args)}`, "utf16le"));
        return await schtasks(["/Create", "/TN", logonTaskName(user), "/XML", file, "/F"]);
    } catch {
        return false;
    } finally {
        await rm(file, { force: true }).catch(() => undefined);
    }
}

/** True once no task is left: deleted now, or there was none to begin with. */
async function removeLogonTask(): Promise<boolean> {
    const name = logonTaskName(account().user);
    if (await schtasks(["/Delete", "/TN", name, "/F"])) return true;
    return !(await schtasks(["/Query", "/TN", name]));
}

/**
 * The task when Windows takes it, the Run key when it does not, never both: with
 * both, the second start reaches the first as a second instance and brings the
 * window to the front.
 */
async function setWindows(open: boolean): Promise<void> {
    if (!open) {
        setRunEntry(false);
        if (!(await removeLogonTask())) throw new Error("the logon task could not be removed");
        return;
    }
    setRunEntry(!(await registerLogonTask()));
}

async function apply(open: boolean): Promise<void> {
    if (process.platform === "linux") return setLinux(open);
    if (process.platform === "win32") return setWindows(open);
    app.setLoginItemSettings({ openAtLogin: open });
}

/**
 * Only an installed app: a development run has no business starting with the computer.
 * Answers whether it took. A preference that could not be written never stops the app
 * opening: an autostart folder can be read-only.
 */
export async function setOpenAtLogin(open: boolean): Promise<boolean> {
    if (!app.isPackaged) return true;
    try {
        await apply(open);
        return true;
    } catch (caught) {
        console.error("polaris: opening with the computer could not be set:", caught);
        return false;
    }
}
