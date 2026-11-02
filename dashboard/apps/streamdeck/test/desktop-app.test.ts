/** The app is preferred only where it answers polaris:// links. */

import { describe, expect, it } from "vitest";
import { desktopAppInstalled, desktopLink } from "../src/desktop-app";

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
    const answers = async () => undefined;
    const refuses = async () => {
        throw new Error("not found");
    };
    const noFile = async () => {
        throw new Error("ENOENT");
    };

    it("asks the registry on Windows, without a shell", async () => {
        const asked: unknown[] = [];
        const run = async (file: string, args: readonly string[]) => void asked.push([file, ...args]);
        expect(await desktopAppInstalled("win32", run, noFile, "/home/x")).toBe(true);
        expect(asked[0]).toEqual(["reg", "query", "HKCU\\Software\\Classes\\polaris\\shell\\open\\command"]);
        expect(await desktopAppInstalled("win32", refuses, noFile, "/home/x")).toBe(false);
    });

    it("reads the app's own list of links on macOS", async () => {
        const read = (body: string) => async () => body;
        expect(await desktopAppInstalled("darwin", answers, read("<string>polaris</string>"), "/h")).toBe(true);
        expect(await desktopAppInstalled("darwin", answers, read("<plist></plist>"), "/h")).toBe(false);
        expect(await desktopAppInstalled("darwin", answers, noFile, "/h")).toBe(false);
    });

    it("does not look elsewhere", async () => {
        expect(await desktopAppInstalled("linux", answers, noFile, "/h")).toBe(false);
    });
});
