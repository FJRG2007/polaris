/**
 * BUG-0020 in a real Electron, headless: every way a link is clicked in the
 * desktop app reaches the routes that hand it to the system, and a link no route
 * could open says so with Copy link.
 *
 * The desktop's own window (`openPolarisWindow`: the window-open handler and the
 * navigation guard), preload and right-click menu are used as they ship, and
 * the page draws the dashboard's real mail frame (`frame-document.ts`) and
 * `openLink`. Only the last step is swapped: the registry reader, the process
 * launcher, `shell.openExternal`, the dialog and the clipboard are recorders,
 * so no browser is ever started, no window is shown, and nothing is written to
 * the clipboard of the machine it runs on.
 *
 * Run with `npm run test:electron` (see `run.mjs`).
 */

import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync } from "node:fs";
import { CHANNELS } from "@/shared/bridge";
import { openPolarisWindow } from "@/main/windows";
import { isSafeExternalUrl } from "@/main/navigation";
import { installContextMenu } from "@/main/context-menu";
import { app, clipboard, dialog, ipcMain, type WebContents } from "electron";
import { openExternal, outsideSystem } from "@/main/open-external";

app.commandLine.appendSwitch("mute-audio");
app.setPath("userData", mkdtempSync(join(tmpdir(), "polaris-links-")));

/** Every link that reached a route, by route. */
const reached: string[] = [];
let failing = false;
const refuse = () => Promise.reject(new Error("refused by the harness"));
outsideSystem.readRegistry = async (key) =>
    key.endsWith("UserChoice") ? "BraveHTML" : key.includes("BraveHTML") ? String.raw`"C:\Harness\brave.exe" --single-argument %1` : null;
outsideSystem.launch = async (file, args) => {
    if (failing) return refuse();
    reached.push(`launch ${file} ${args.join(" ")}`);
};
outsideSystem.open = async (url) => {
    if (failing) return refuse();
    reached.push(`open ${url}`);
};
outsideSystem.opener = async (file, url) => {
    if (failing) return refuse();
    reached.push(`${file} ${url}`);
};
const dialogs: string[] = [];
const copied: string[] = [];
(dialog as { showMessageBox: unknown; }).showMessageBox = async (...args: unknown[]) => {
    const options = args[args.length - 1] as { message: string; detail: string; buttons: string[]; };
    dialogs.push(`${options.message} | ${options.buttons.join(",")} | ${options.detail}`);
    return { response: 0, checkboxChecked: false };
};
(clipboard as { writeText: unknown; }).writeText = (text: string) => {
    copied.push(text);
};

const pageJs = readFileSync(join(__dirname, "page.js"), "utf8");
const MAIN_LINKS = `<a id=plain href="https://example.org/plain" style="position:absolute;left:600px;top:20px;width:150px;height:40px;display:block">plain</a>
<a id=blank href="https://example.org/blank" target="_blank" style="position:absolute;left:600px;top:100px;width:150px;height:40px;display:block">blank</a>`;
const server = createServer((_request, response) => {
    response.setHeader("content-type", "text/html");
    // The headers the live /mail page is sent with.
    response.setHeader("Content-Security-Policy", "frame-ancestors 'self'; frame-src 'self'");
    response.end(`<!doctype html><html><body style="margin:0">${MAIN_LINKS}<script>${pageJs.split("</script").join("<\\/script")}</script></body></html>`);
});
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Poll until `check` holds, for at most `ms`; whether it did. */
async function until(check: () => boolean | Promise<boolean>, ms = 10_000): Promise<boolean> {
    const end = Date.now() + ms;
    while (Date.now() < end) {
        if (await check()) return true;
        await wait(50);
    }
    return false;
}

/** A real click, sent through the browser's input router. */
async function click(contents: WebContents, x: number, y: number, button: "left" | "middle"): Promise<void> {
    // The pointer arrives first, as a real one does.
    await contents.debugger.sendCommand("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
    await wait(100);
    for (const type of ["mousePressed", "mouseReleased"])
        await contents.debugger.sendCommand("Input.dispatchMouseEvent", { type, x, y, button, buttons: button === "left" ? 1 : 4, clickCount: 1 });
}

let failures = 0;
function expect(name: string, ok: boolean, detail: string): void {
    if (!ok) failures++;
    console.log(`${ok ? "PASS" : "FAIL"} ${name}: ${detail}`);
}

app.on("web-contents-created", (_event, contents) => installContextMenu(contents));
app.whenReady().then(() =>
    server.listen(0, "127.0.0.1", async () => {
        const address = server.address();
        const origin = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
        // As `ipc.ts` registers it, without the rest of the app's channels.
        ipcMain.handle(CHANNELS.openOutside, (_event, raw: unknown) => {
            if (typeof raw !== "string" || !isSafeExternalUrl(raw)) return false;
            openExternal(raw);
            return true;
        });
        const window = openPolarisWindow(`${origin}/mail`, () => origin, { hidden: true, width: 900, height: 500 });
        const contents = window.webContents;
        await new Promise((resolve) => contents.once("did-finish-load", () => resolve(undefined)));
        contents.debugger.attach("1.3");
        // The mail frame's own script has to be running before it is clicked.
        const framed = await until(async () => {
            const frame = contents.mainFrame.frames[0];
            return Boolean(frame) && (await frame!.executeJavaScript("document.readyState").catch(() => "")) === "complete";
        });
        expect("the mail frame drew", framed, framed ? "loaded" : "never loaded");
        // Input is routed to the frame a moment after its document completes;
        // a click before that lands on nothing.
        await wait(1500);
        const cases: [string, number, number, "left" | "middle", string][] = [
            ["mail button, left click", 60, 40, "left", "https://example.com/track?id=42"],
            ["mail button, middle click", 60, 40, "middle", "https://example.com/track?id=42"],
            ["main-frame plain link", 650, 40, "left", "https://example.org/plain"],
            ["main-frame target=_blank link", 650, 120, "left", "https://example.org/blank"]
        ];
        for (const [name, x, y, button, url] of cases) {
            const before = reached.length;
            await click(contents, x, y, button);
            await until(() => reached.length > before, 5_000);
            // Long enough for a second, duplicate hand-over to show up too.
            await wait(300);
            const got = reached.slice(before);
            expect(name, got.length === 1 && got[0]!.includes(url), got.join(", ") || "nothing reached a route");
        }
        expect("the page stays on Polaris", contents.getURL() === `${origin}/mail`, contents.getURL());

        // Every route failing: the person is told, and Copy link copies it.
        failing = true;
        openExternal("https://example.net/failed?x=1");
        await until(() => dialogs.length > 0 && copied.length > 0, 5_000);
        expect("a link no route opened shows the dialog", dialogs.length === 1 && dialogs[0]!.includes("Copy link") && dialogs[0]!.includes("https://example.net/failed?x=1"), dialogs.join(" / ") || "no dialog");
        expect("Copy link copies the address", copied.includes("https://example.net/failed?x=1"), copied.join(", ") || "nothing copied");

        console.log(failures === 0 ? "HARNESS OK" : `HARNESS FAILED ${failures}`);
        server.close();
        app.exit(failures === 0 ? 0 : 1);
    })
);
