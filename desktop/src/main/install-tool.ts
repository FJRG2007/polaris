/**
 * Installing a tool on this computer from the page that offers it, so nobody
 * pastes a line into a terminal.
 *
 * The page names a tool and nothing else, and the app asks in a dialog of its
 * own before anything runs: the dashboard renders text other people wrote, and
 * one Polaris of several must not install something unasked. What runs is the
 * script `shared/install-tools.ts` names.
 */

import { homedir } from "node:os";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { repository } from "../../package.json";
import * as tools from "@/shared/install-tools";
import { clipboard, dialog, shell, type BrowserWindow } from "electron";

/** The most a script may take: a slow download, not a stuck one. */
const INSTALL_TIMEOUT_MS = 5 * 60_000;
/** The most a shell may take to start and say its PATH. */
const SHELL_TIMEOUT_MS = 10_000;

let running = false;

function run(launch: tools.Launch, timeout: number, env = process.env): Promise<{ code: number | null; output: string; }> {
    return new Promise((resolve, reject) => {
        const child = spawn(launch.file, [...launch.args], {
            windowsHide: true,
            stdio: ["ignore", "pipe", "pipe"],
            timeout,
            env
        });
        let output = "";
        const keep = (chunk: Buffer) => {
            output = (output + chunk.toString()).slice(-16_384);
        };
        child.stdout.on("data", keep);
        child.stderr.on("data", keep);
        child.on("error", reject);
        child.on("close", (code) => resolve({ code, output }));
    });
}

/** The environment a script runs in: on macOS and Linux, with the PATH of the
 *  user's own shell. */
async function scriptEnvironment(): Promise<NodeJS.ProcessEnv> {
    if (process.platform === "win32") return process.env;
    const launch = { file: process.env.SHELL || "/bin/sh", args: ["-ilc", tools.PATH_PROBE] };
    const { output } = await run(launch, SHELL_TIMEOUT_MS).catch(() => ({ output: "" }));
    return { ...process.env, PATH: tools.installPath(output, process.env.PATH) };
}

function folders(): tools.Folders {
    return {
        home: homedir(),
        localAppData: process.env.LOCALAPPDATA,
        appData: process.env.APPDATA,
        xdgData: process.env.XDG_DATA_HOME
    };
}

/** The steps left for the browser: it opens on its extensions page, with the
 *  folder to choose already copied and shown. */
function handOver(browser: tools.ExtensionBrowser | undefined, folder: string): void {
    clipboard.writeText(folder);
    shell.showItemInFolder(folder);
    if (!browser) return;
    const launch = tools.extensionsPageLaunch(browser, process.platform);
    const child = spawn(launch.file, [...launch.args], { windowsHide: true, stdio: "ignore", detached: true });
    // A browser that is not there leaves the copied folder and the steps on screen.
    child.on("error", (error) => console.error("polaris: the browser did not open:", error));
    child.unref();
}

export async function installTool(window: BrowserWindow, input: tools.InstallRequest): Promise<tools.InstallResult> {
    const repo = tools.repositorySlug(repository);
    if (!repo || !tools.installable(input.tool, process.platform)) return { ok: false, reason: "unsupported" };
    if (running) return { ok: false, reason: "busy" };
    running = true;
    try {
        const { response } = await dialog.showMessageBox(window, {
            type: "question",
            buttons: ["Install", "Cancel"],
            defaultId: 0,
            cancelId: 1,
            message: tools.installQuestion(input.tool),
            detail: "It downloads the official release from GitHub and needs no administrator rights."
        });
        if (response !== 0) return { ok: false, reason: "cancelled" };
        const launch = tools.installLaunch(input.tool, process.platform, repo);
        const { code, output } = await run(launch, INSTALL_TIMEOUT_MS, await scriptEnvironment());
        const path = tools.installedPath(input.tool, process.platform, folders());
        if (code !== 0 || !tools.scriptFinished(input.tool, output) || !existsSync(path)) {
            console.error("polaris: an install ended without the tool:", code, output);
            return tools.installFailure(input.tool, output, homedir());
        }
        if (input.tool === "extension") handOver(input.browser, path);
        return { ok: true };
    } catch (error) {
        console.error("polaris: an install did not run:", error);
        return { ok: false, reason: "failed" };
    } finally {
        running = false;
    }
}
