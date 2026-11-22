import { describe, expect, it } from "vitest";
import { convert, evaluate, quickAnswer } from "@/shared/quick-answer";
import { matchScore, topMatches, webSearchUrl } from "@/shared/launcher";
import { conflictSentence, findLaunchers, likelyHolders } from "@/shared/launcher-conflicts";
import { CLIPBOARD_LIMIT, isConcealed, withClip, type ClipboardProbe } from "@/shared/clipboard-history";
import { bindingFromPress, DEFAULT_LAUNCHER_BINDING, displayAccelerator, launcherAccelerator, type KeyPress } from "@/shared/launcher-hotkey";

const press = (code: string, held: Partial<Omit<KeyPress, "code">> = {}): KeyPress => ({
    code,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    ...held
});

describe("the launcher's key", () => {
    it("defaults to Alt+Space, which the system can hold", () => {
        expect(DEFAULT_LAUNCHER_BINDING).toBe("Alt+Space");
        expect(launcherAccelerator(DEFAULT_LAUNCHER_BINDING)).toBe("Alt+Space");
    });

    it("records a press by its place on the keyboard", () => {
        expect(bindingFromPress(press("Space", { altKey: true }), "win32")).toBe("Alt+Space");
        expect(bindingFromPress(press("KeyK", { ctrlKey: true, shiftKey: true }), "win32")).toBe("Mod+Shift+K");
        expect(bindingFromPress(press("KeyK", { metaKey: true }), "darwin")).toBe("Mod+K");
        expect(bindingFromPress(press("F9"), "linux")).toBe("F9");
        expect(bindingFromPress(press("Digit1", { altKey: true }), "win32")).toBe("Alt+1");
    });

    it("refuses presses nobody may take from every program", () => {
        expect(bindingFromPress(press("KeyK"), "win32")).toBeNull();
        expect(bindingFromPress(press("Space", { shiftKey: true }), "win32")).toBeNull();
        expect(bindingFromPress(press("AltLeft", { altKey: true }), "win32")).toBeNull();
        // The Windows key and Ctrl on a Mac are not offered.
        expect(bindingFromPress(press("KeyK", { metaKey: true }), "win32")).toBeNull();
        expect(bindingFromPress(press("KeyK", { ctrlKey: true }), "darwin")).toBeNull();
    });

    it("names keys the way each platform does", () => {
        expect(displayAccelerator("Alt+Space", "win32")).toBe("Alt+Space");
        expect(displayAccelerator("Alt+Space", "darwin")).toBe("Option+Space");
        expect(displayAccelerator("CommandOrControl+Shift+K", "darwin")).toBe("Cmd+Shift+K");
        expect(displayAccelerator("CommandOrControl+Plus", "linux")).toBe("Ctrl++");
    });
});

describe("who holds the key", () => {
    it("finds launchers by installed name and running program", () => {
        const found = findLaunchers(
            "win32",
            ["PowerToys (Preview)", "Notepad", "Flow Launcher"],
            ["explorer.exe", "C:\\Program Files\\PowerToys\\PowerToys.PowerLauncher.exe", "Raycast.exe"]
        );
        expect(found).toEqual([
            { name: "Raycast", running: true, defaultAccelerator: "Alt+Space" },
            { name: "PowerToys Run", running: true, defaultAccelerator: "Alt+Space" },
            { name: "Flow Launcher", running: false, defaultAccelerator: "Alt+Space" }
        ]);
    });

    it("ignores launchers of another platform", () => {
        expect(findLaunchers("linux", ["Raycast"], ["Alfred"])).toEqual([]);
        expect(findLaunchers("darwin", [], ["Alfred"]).map((found) => found.name)).toEqual(["Alfred"]);
    });

    it("names running launchers with that default first, and never an idle one with another default", () => {
        const found = [
            { name: "Listary", running: true, defaultAccelerator: null },
            { name: "Flow Launcher", running: false, defaultAccelerator: "Alt+Space" },
            { name: "Raycast", running: true, defaultAccelerator: "Alt+Space" },
            { name: "Wox", running: false, defaultAccelerator: null }
        ];
        expect(likelyHolders("Alt+Space", found)).toEqual(["Raycast", "Listary", "Flow Launcher"]);
        expect(likelyHolders("CommandOrControl+K", found)).toEqual(["Listary", "Raycast"]);
    });

    it("says what to do in either case", () => {
        expect(conflictSentence("Alt+Space", ["Raycast", "PowerToys Run"])).toBe(
            "Alt+Space is in use, most likely by Raycast or PowerToys Run. Change the shortcut there, or record another one here."
        );
        expect(conflictSentence("Alt+Space", [])).toMatch(/^Alt\+Space is in use by another program/);
    });
});

const probe = (formats: Record<string, Uint8Array | null>): ClipboardProbe => ({
    has: async (format) => format in formats,
    read: async (format) => formats[format] ?? null
});

describe("the clipboard history's filter", () => {
    it("skips what password managers mark on each platform", async () => {
        expect(await isConcealed("win32", probe({ ExcludeClipboardContentFromMonitorProcessing: null }))).toBe(true);
        expect(await isConcealed("win32", probe({ CanIncludeInClipboardHistory: new Uint8Array([0, 0, 0, 0]) }))).toBe(true);
        expect(await isConcealed("darwin", probe({ "org.nspasteboard.ConcealedType": null }))).toBe(true);
        expect(await isConcealed("darwin", probe({ "org.nspasteboard.TransientType": null }))).toBe(true);
        expect(await isConcealed("linux", probe({ "x-kde-passwordManagerHint": new TextEncoder().encode("secret") }))).toBe(true);
    });

    it("keeps ordinary copies and ones allowed into history", async () => {
        expect(await isConcealed("win32", probe({}))).toBe(false);
        expect(await isConcealed("win32", probe({ CanIncludeInClipboardHistory: new Uint8Array([1, 0, 0, 0]) }))).toBe(false);
        expect(await isConcealed("darwin", probe({ ExcludeClipboardContentFromMonitorProcessing: null }))).toBe(false);
    });

    it("treats a marker it cannot read as a reason to skip", async () => {
        expect(await isConcealed("win32", probe({ CanIncludeInClipboardHistory: null }))).toBe(true);
    });

    it("keeps the newest first, without repeats, blanks or more than the limit", () => {
        let history = withClip([], "one", 1);
        history = withClip(history, "two", 2);
        history = withClip(history, "one", 3);
        history = withClip(history, "   ", 4);
        expect(history.map((entry) => entry.text)).toEqual(["one", "two"]);
        for (let at = 0; at < CLIPBOARD_LIMIT + 50; at += 1) history = withClip(history, `copy ${at}`, at);
        expect(history).toHaveLength(CLIPBOARD_LIMIT);
        expect(history[0]?.text).toBe(`copy ${CLIPBOARD_LIMIT + 49}`);
        expect(withClip([], "x".repeat(20_001), 1)).toEqual([]);
    });
});

describe("quick answers", () => {
    it("works out arithmetic with precedence, powers and functions", () => {
        expect(evaluate("1 + 2 * 3")).toBe(7);
        expect(evaluate("(1 + 2) * 3")).toBe(9);
        expect(evaluate("2 ^ 3 ^ 2")).toBe(512);
        expect(evaluate("-2 ^ 2")).toBe(-4);
        expect(evaluate("10 % 4")).toBe(2);
        expect(evaluate("sqrt(16) + abs(-2)")).toBe(6);
        expect(evaluate("2 * pi")).toBeCloseTo(6.283185307);
    });

    it("refuses what is not arithmetic, and never runs it", () => {
        expect(evaluate("1 +")).toBeNull();
        expect(evaluate("alert(1)")).toBeNull();
        expect(evaluate("process.exit()")).toBeNull();
        expect(evaluate("1 / 0")).toBeNull();
        expect(quickAnswer("42")).toBeNull();
        expect(quickAnswer("hello world")).toBeNull();
    });

    it("answers a sum with a tidy number", () => {
        expect(quickAnswer("0.1 + 0.2")).toEqual({ value: "0.3", label: "0.1 + 0.2" });
        expect(quickAnswer("2^10 / 4")?.value).toBe("256");
    });

    it("converts units within one family", () => {
        expect(convert("5 km to mi")?.value).toBe("3.106855961");
        expect(convert("100 f in c")?.value).toBe("37.77777778");
        expect(convert("0 c to k")?.value).toBe("273.15");
        expect(convert("1 gib to mb")?.value).toBe("1073.741824");
        expect(convert("2 h in min")?.value).toBe("120");
        expect(convert("5 km to kg")).toBeNull();
        expect(convert("5 parsecs to m")).toBeNull();
    });
});

describe("the launcher's list", () => {
    const items = [
        { label: "Deploy", context: "Polaris" },
        { label: "polaris-web", context: "Deploy project" },
        { label: "Web server", context: "Installed app" },
        { label: "Notes", context: "Polaris" }
    ];

    it("ranks a name's start above a word's start above a context match", () => {
        expect(topMatches("web", items, 5).map((item) => item.label)).toEqual(["Web server", "polaris-web"]);
        expect(topMatches("deploy", items, 5).map((item) => item.label)).toEqual(["Deploy", "polaris-web"]);
        expect(matchScore("", items[0]!)).toBe(0);
        expect(topMatches("pw", items, 5).map((item) => item.label)).toEqual(["polaris-web"]);
    });

    it("sends a web search with the query encoded", () => {
        expect(webSearchUrl("duckduckgo", " a&b c ")).toBe("https://duckduckgo.com/?q=a%26b%20c");
    });
});
