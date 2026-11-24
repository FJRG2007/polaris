/**
 * The default browser's registered command, read and started without a shell
 * (BUG-0020). Nothing here touches the real registry or starts a process: the
 * reader is a table and only the parsed command is checked.
 */

import { describe, expect, it, vi } from "vitest";
import { launchFor, parseRegQuery, registeredLaunch, splitArguments } from "../../src/main/default-browser";

const URL_IN = "https://click.example.com/ls/click?upn=a1B2%2Fx&b=2";

describe("launchFor", () => {
    it("reads Brave's command", () => {
        expect(launchFor(String.raw`"C:\Program Files\BraveSoftware\Brave-Browser\Application\brave.exe" --single-argument %1`, URL_IN)).toEqual({
            file: String.raw`C:\Program Files\BraveSoftware\Brave-Browser\Application\brave.exe`,
            args: ["--single-argument", URL_IN]
        });
    });

    it("reads Chrome's command, current and older", () => {
        expect(launchFor(String.raw`"C:\Program Files\Google\Chrome\Application\chrome.exe" --single-argument %1`, URL_IN)?.args).toEqual(["--single-argument", URL_IN]);
        expect(launchFor(String.raw`"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe" -- "%1"`, URL_IN)).toEqual({
            file: String.raw`C:\Program Files (x86)\Google\Chrome\Application\chrome.exe`,
            args: ["--", URL_IN]
        });
    });

    it("reads Edge's command", () => {
        expect(launchFor(String.raw`"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" --single-argument %1`, URL_IN)).toEqual({
            file: String.raw`C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe`,
            args: ["--single-argument", URL_IN]
        });
    });

    it("reads Firefox's command, with the link inside quotes", () => {
        expect(launchFor(String.raw`"C:\Program Files\Mozilla Firefox\firefox.exe" -osint -url "%1"`, URL_IN)).toEqual({
            file: String.raw`C:\Program Files\Mozilla Firefox\firefox.exe`,
            args: ["-osint", "-url", URL_IN]
        });
    });

    it("expands an environment variable in an expandable command", () => {
        expect(launchFor(String.raw`"%ProgramFiles%\Mozilla Firefox\firefox.exe" -osint -url "%1"`, URL_IN, { PROGRAMFILES: String.raw`C:\Program Files` })?.file).toBe(
            String.raw`C:\Program Files\Mozilla Firefox\firefox.exe`
        );
    });

    it("reads an unquoted path with spaces up to its .exe", () => {
        expect(launchFor(String.raw`C:\Users\someone\AppData\Local\Programs\Opera GX\launcher.exe -noautoupdate -- "%1"`, URL_IN)).toEqual({
            file: String.raw`C:\Users\someone\AppData\Local\Programs\Opera GX\launcher.exe`,
            args: ["-noautoupdate", "--", URL_IN]
        });
    });

    it("reads a mail app's command for a mail link", () => {
        expect(launchFor(String.raw`"C:\Program Files\Microsoft Office\Root\Office16\OUTLOOK.EXE" -c IPM.Note /m "%1"`, "mailto:a@example.com")?.args).toEqual([
            "-c",
            "IPM.Note",
            "/m",
            "mailto:a@example.com"
        ]);
    });

    it("puts the link last when the command has no placeholder, and drops %*", () => {
        expect(launchFor(String.raw`"C:\Browsers\b.exe" %*`, URL_IN)?.args).toEqual([URL_IN]);
        expect(launchFor(String.raw`"C:\Browsers\b.exe"`, URL_IN)?.args).toEqual([URL_IN]);
    });

    it("keeps the link one argument whatever it holds", () => {
        const odd = "https://example.com/a%20b?q=%22x%22&r=%25";
        expect(launchFor(String.raw`"C:\B\b.exe" --single-argument %1`, odd)?.args).toEqual(["--single-argument", odd]);
    });

    it("refuses a relative or network path, a non-exe and a program that runs its argument", () => {
        for (const command of [
            String.raw`brave.exe %1`,
            String.raw`"\server\share\b.exe" %1`,
            String.raw`"C:\B\script.bat" %1`,
            String.raw`"C:\Windows\System32\cmd.exe" /c start %1`,
            String.raw`C:\Windows\System32\rundll32.exe url.dll,FileProtocolHandler %1`,
            String.raw`"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe" %1`,
            `"unterminated %1`
        ])
            expect(launchFor(command, URL_IN)).toBeNull();
    });
});

describe("splitArguments", () => {
    it("splits as a Windows program reads its command line", () => {
        expect(splitArguments(String.raw` a "b c" d""e "f""g" h\\"i j" k\"l m\n`)).toEqual(["a", "b c", "de", 'f"g', String.raw`h\i j`, 'k"l', String.raw`m\n`]);
        expect(splitArguments(`""`)).toEqual([""]);
        expect(splitArguments("   ")).toEqual([]);
    });
});

describe("parseRegQuery", () => {
    it("reads a value whatever the default value is called in this language", () => {
        const command = String.raw`"C:\B\brave.exe" --single-argument %1`;
        const key = String.raw`HKEY_CLASSES_ROOT\BraveHTML\shell\open\command`;
        const english = `\r\n${key}\r\n    (Default)    REG_SZ    ${command}\r\n\r\n`;
        const spanish = `\r\n${key}\r\n    (Predeterminado)    REG_SZ    ${command}\r\n`;
        expect(parseRegQuery(english)).toBe(command);
        expect(parseRegQuery(spanish)).toBe(command);
        expect(parseRegQuery(`\r\n${String.raw`HKEY_CURRENT_USER\x\UserChoice`}\r\n    ProgId    REG_SZ    BraveHTML\r\n`)).toBe("BraveHTML");
        expect(parseRegQuery("")).toBeNull();
    });
});

describe("registeredLaunch", () => {
    const table = (entries: Record<string, string>) => vi.fn(async (key: string, value: string | null) => entries[`${key}|${value ?? ""}`] ?? null);
    const choice = (scheme: string) => `${String.raw`HKCU\Software\Microsoft\Windows\Shell\Associations\UrlAssociations\ `.trim()}${scheme}${String.raw`\UserChoice`}|ProgId`;
    const command = (progId: string) => `HKCR\\${progId}\\shell\\open\\command|`;

    it("follows the person's choice to the browser's command", async () => {
        const read = table({
            [choice("https")]: "BraveHTML",
            [command("BraveHTML")]: String.raw`"C:\B\brave.exe" --single-argument %1`
        });
        await expect(registeredLaunch(URL_IN, read, {})).resolves.toEqual({ file: String.raw`C:\B\brave.exe`, args: ["--single-argument", URL_IN] });
    });

    it("reads the scheme of the link: http and mailto have choices of their own", async () => {
        const read = table({ [choice("http")]: "ChromeHTML", [command("ChromeHTML")]: String.raw`"C:\C\chrome.exe" -- "%1"` });
        await expect(registeredLaunch("http://example.com/", read, {})).resolves.toEqual({ file: String.raw`C:\C\chrome.exe`, args: ["--", "http://example.com/"] });
        await expect(registeredLaunch("mailto:a@example.com", read, {})).resolves.toBeNull();
    });

    it("gives up, for the system route, when a step is missing or odd", async () => {
        await expect(registeredLaunch(URL_IN, table({}), {})).resolves.toBeNull();
        await expect(registeredLaunch(URL_IN, table({ [choice("https")]: "AppXq0fevzme2pys62n3e0fbqa7peapykr8v" }), {})).resolves.toBeNull();
        const traversal = table({ [choice("https")]: String.raw`..\..\Evil`, [command(String.raw`..\..\Evil`)]: String.raw`"C:\E\e.exe" %1` });
        await expect(registeredLaunch(URL_IN, traversal, {})).resolves.toBeNull();
        await expect(registeredLaunch("file:///C:/x", table({}), {})).resolves.toBeNull();
    });
});
