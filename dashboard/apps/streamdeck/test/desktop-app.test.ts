/** The app is preferred only where it answers polaris:// links. */

import { describe, expect, it } from "vitest";
import { desktopAppInstalled, desktopLink, desktopOpener } from "../src/desktop-app";

describe("the link to the app", () => {
    it("carries the server and the whole page", () => {
        const link = desktopLink("https://polaris.example:8443/account/tv?code=AB#x");
        const parsed = new URL(link ?? "");
        expect(parsed.protocol).toBe("polaris:");
        expect(parsed.hostname).toBe("open");
        expect(parsed.searchParams.get("server")).toBe("https://polaris.example:8443");
        expect(parsed.searchParams.get("path")).toBe("/account/tv?code=AB#x");
    });

    it("is null for what is not an address", () => {
        expect(desktopLink("not an address")).toBeNull();
    });
});

describe("finding the app", () => {
    const REGISTERED = [
        "",
        "HKEY_CURRENT_USER\\Software\\Classes\\polaris\\shell\\open\\command",
        '    (Default)    REG_SZ    "C:\\Apps\\polaris-desktop\\app-0.1.7\\polaris.exe" "%1"',
        ""
    ].join("\r\n");
    const answers = async () => "";
    const refuses = async () => {
        throw new Error("not found");
    };
    const noFile = async () => {
        throw new Error("ENOENT");
    };

    it("asks the registry on Windows, without a shell", async () => {
        const asked: unknown[] = [];
        const run = async (file: string, args: readonly string[]) => {
            asked.push([file, ...args]);
            return REGISTERED;
        };
        const checked: string[] = [];
        const exists = async (path: string) => {
            checked.push(path);
            return true;
        };
        expect(await desktopAppInstalled("win32", run, noFile, "/home/x", exists)).toBe(true);
        expect(asked[0]).toEqual(["reg", "query", "HKCU\\Software\\Classes\\polaris\\shell\\open\\command"]);
        expect(checked).toEqual(["C:\\Apps\\polaris-desktop\\app-0.1.7\\polaris.exe"]);
        expect(await desktopAppInstalled("win32", refuses, noFile, "/home/x", exists)).toBe(false);
    });

    it("does not trust a Windows key whose program is gone", async () => {
        const run = async () => REGISTERED;
        expect(await desktopAppInstalled("win32", run, noFile, "/home/x", async () => false)).toBe(false);
        expect(await desktopAppInstalled("win32", answers, noFile, "/home/x", async () => true)).toBe(false);
    });

    it("reads the app's own list of links on macOS", async () => {
        const read = (body: string) => async () => body;
        const schemes = "<key>CFBundleURLSchemes</key>\n<array>\n<string>polaris</string>\n</array>";
        expect(await desktopAppInstalled("darwin", answers, read(schemes), "/h")).toBe(true);
        expect(await desktopAppInstalled("darwin", answers, read("<plist></plist>"), "/h")).toBe(false);
        expect(await desktopAppInstalled("darwin", answers, noFile, "/h")).toBe(false);
    });

    it("does not take the macOS executable's name for a link", async () => {
        const plist = [
            "<key>CFBundleExecutable</key><string>polaris</string>",
            "<key>CFBundleURLSchemes</key><array><string>other</string></array>",
            "<key>CFBundleName</key><string>polaris</string>"
        ].join("\n");
        expect(await desktopAppInstalled("darwin", answers, async () => plist, "/h")).toBe(false);
    });

    it("does not look elsewhere", async () => {
        expect(await desktopAppInstalled("linux", answers, noFile, "/h")).toBe(false);
    });
});

describe("opening in the app", () => {
    const URL_OF_A_PAGE = "https://polaris.example/chat";
    const opened = async () => undefined;

    it("opens the link when the app is there", async () => {
        const links: string[] = [];
        const open = desktopOpener(
            async () => true,
            async (link) => void links.push(link)
        );
        expect(await open(URL_OF_A_PAGE)).toBe(true);
        expect(links).toEqual([desktopLink(URL_OF_A_PAGE)]);
    });

    it("leaves it to the browser when the app is not there", async () => {
        expect(await desktopOpener(async () => false, opened)(URL_OF_A_PAGE)).toBe(false);
    });

    it("leaves it to the browser when the app refuses the link", async () => {
        const open = desktopOpener(
            async () => true,
            async () => {
                throw new Error("no handler");
            }
        );
        expect(await open(URL_OF_A_PAGE)).toBe(false);
    });

    it("leaves it to the browser for what is not an address", async () => {
        expect(await desktopOpener(async () => true, opened)("not an address")).toBe(false);
    });

    it("asks whether the app is there once a minute at most", async () => {
        let asked = 0;
        let time = 0;
        const installed = async () => {
            asked += 1;
            return true;
        };
        const open = desktopOpener(installed, opened, () => time);
        await open(URL_OF_A_PAGE);
        time = 60_000;
        await open(URL_OF_A_PAGE);
        expect(asked).toBe(1);
        time = 60_001;
        await open(URL_OF_A_PAGE);
        expect(asked).toBe(2);
    });
});
