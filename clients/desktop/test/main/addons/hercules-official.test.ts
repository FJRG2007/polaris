import { describe, expect, it } from "vitest";
import * as official from "@/main/addons/hercules-official";

/**
 * Fixtures only: nothing here reads this machine's registry, processes or
 * Stream Control's real settings file, and nothing is stopped or removed.
 */

const X86 = "C:\\Program Files (x86)";
const APP_KEY = "{4E736157-448C-4D22-BF3F-1C58BE6E9B9E}";
const DRV_KEY = "{B59074DF-80BE-4F30-AE11-6AB0B93EDE56}";
const BS = String.fromCharCode(92);

/** The shape `reg.exe query ... /s` prints, with the values Hercules' 2.05.8 installer registers. */
const REG = [
    "",
    `HKEY_LOCAL_MACHINE\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${APP_KEY}`,
    "    DisplayName    REG_SZ    Hercules Stream Control",
    "    Publisher    REG_SZ    Hercules",
    "    DisplayVersion    REG_SZ    2.05.8.0",
    `    UninstallString    REG_SZ    "${X86}\\InstallShield Installation Information\\${APP_KEY}\\setup.exe" -runfromtemp -l0x0409  -removeonly`,
    "    InstallLocation    REG_SZ    C:\\Program Files (x86)\\Hercules\\Hercules Stream Control",
    "",
    `HKEY_LOCAL_MACHINE\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${DRV_KEY}`,
    "    DisplayName    REG_SZ    HSM Series drivers",
    "    Publisher    REG_SZ    Hercules",
    `    UninstallString    REG_SZ    "${X86}\\InstallShield Installation Information\\${DRV_KEY}\\setup.exe" -runfromtemp -l0x0409  -removeonly -remove`,
    "",
    "HKEY_LOCAL_MACHINE\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\{00000000-0000-0000-0000-000000000001}",
    "    DisplayName    REG_SZ    Some Other App",
    "    Publisher    REG_SZ    Example Vendor",
    "",
    "HKEY_LOCAL_MACHINE\\Software\\Microsoft\\Windows\\CurrentVersion\\Run",
    "    Hercules-Stream-Control    REG_SZ    C:\\Program Files\\Hercules\\Hercules Stream Control\\Stream-control.exe -minimized",
    "    Example    REG_SZ    \"C:\\Program Files\\Example\\example.exe\" --background",
    ""
].join("\r\n");

const TASKS = "\"System Idle Process\",\"0\",\"Services\",\"0\",\"8 K\"\r\n\"Stream-control.exe\",\"4242\",\"Console\",\"1\",\"90,000 K\"\r\n";

function found() {
    const result = official.findOfficial(official.parseRegQuery(REG), TASKS);
    if (!result) throw new Error("fixture not found");
    return result;
}

describe("detection", () => {
    it("finds the app, its drivers, the start-with-Windows entry and the running process", () => {
        const result = found();
        expect(result.app?.displayName).toBe("Hercules Stream Control");
        expect(result.drivers?.key).toBe(DRV_KEY);
        expect(result.autostart).toEqual([expect.objectContaining({ hive: "HKLM", name: "Hercules-Stream-Control" })]);
        expect(result.running).toBe(true);
    });

    it("answers null on a machine without any of it", () => {
        expect(official.findOfficial(official.parseRegQuery(""), "\"explorer.exe\",\"1\"")).toBeNull();
    });

    it("ignores another publisher's entry with a Hercules-like name", () => {
        const fake = REG.replace("Publisher    REG_SZ    Example Vendor", "Publisher    REG_SZ    Not Hercules").replace("Some Other App", "Hercules Stream Control Pro");
        const apps = official.installedHercules(official.parseRegQuery(fake));
        expect(apps.map((a) => a.key)).toEqual([APP_KEY, DRV_KEY]);
    });

    it("does not count a process whose name only contains Stream-control", () => {
        expect(official.streamControlRunning("\"Not-Stream-control.exe\",\"7\"")).toBe(false);
    });
});

describe("command lines", () => {
    it("splits like CommandLineToArgvW", () => {
        expect(official.splitCommandLine("\"C:\\a b\\setup.exe\" -x  -y")).toEqual(["C:\\a b\\setup.exe", "-x", "-y"]);
        expect(official.splitCommandLine("a\\\\\"b c\" d")).toEqual(["a\\b c", "d"]);
        expect(official.splitCommandLine("a\\\"b")).toEqual(["a\"b"]);
    });
});

describe("the vendor uninstaller", () => {
    const app = () => found().app!;

    it("accepts the InstallShield setup.exe kept for the package's own product code", () => {
        expect(official.vetUninstaller(app(), X86)).toEqual({
            file: `${X86}\\InstallShield Installation Information\\${APP_KEY}\\setup.exe`,
            args: ["-runfromtemp", "-l0x0409", "-removeonly"]
        });
    });

    it.each([
        ["another folder", "\"C:\\Users\\x\\setup.exe\" -removeonly"],
        ["another product code", `"${X86}\\InstallShield Installation Information\\${DRV_KEY}\\setup.exe" -removeonly`],
        ["a path that climbs out", `"${X86}\\InstallShield Installation Information\\${APP_KEY}\\..\\..\\cmd.exe"`],
        ["an extra argument", `"${X86}\\InstallShield Installation Information\\${APP_KEY}\\setup.exe" -removeonly & calc`],
        ["a script", "cmd.exe /c del C:\\"],
        ["a control character", `"${X86}\\InstallShield Installation Information\\${APP_KEY}\\setup.exe"\n-removeonly`],
        ["an empty string", ""]
    ])("refuses %s", (_, uninstallString) => {
        expect(official.vetUninstaller({ ...app(), uninstallString }, X86)).toBeNull();
    });

    it("refuses an entry from another publisher", () => {
        expect(official.vetUninstaller({ ...app(), publisher: "Example Vendor" }, X86)).toBeNull();
    });
});

describe("the choice", () => {
    it("does nothing and installs nothing on cancel", () => {
        expect(official.planChoice("cancel", found(), X86)).toEqual({ ok: false, reason: "cancelled" });
    });

    it("imports first, then stops it and turns off its start with Windows", () => {
        const plan = official.planChoice("stop", found(), X86);
        expect(plan.ok && plan.steps.map((s) => s.kind)).toEqual(["importSettings", "stopProcess", "removeAutostart", "installAddon"]);
        expect(plan.ok && plan.steps[2]).toMatchObject({ elevated: true });
    });

    it("keeps everything as it is on keep", () => {
        const plan = official.planChoice("keep", found(), X86);
        expect(plan.ok && plan.steps.map((s) => s.kind)).toEqual(["importSettings", "installAddon"]);
    });

    it("uninstalls the app, then the drivers, each by its signed uninstaller", () => {
        const plan = official.planChoice("uninstall", found(), X86);
        expect(plan.ok && plan.steps.filter((s) => s.kind === "runUninstaller")).toEqual([
            expect.objectContaining({ file: expect.stringContaining(APP_KEY), signer: "Guillemot Corporation" }),
            expect.objectContaining({ file: expect.stringContaining(DRV_KEY), args: ["-runfromtemp", "-l0x0409", "-removeonly", "-remove"] })
        ]);
    });

    it("refuses the whole uninstall when one uninstaller fails the check", () => {
        const result = found();
        const tampered = { ...result, drivers: { ...result.drivers!, uninstallString: "powershell -c evil" } };
        expect(official.planChoice("uninstall", tampered, X86)).toEqual({ ok: false, reason: "uninstallerRefused" });
    });

    it("has nothing to uninstall when only the start entry is left", () => {
        expect(official.planChoice("uninstall", { app: null, drivers: null, autostart: [], running: true }, X86)).toEqual({ ok: false, reason: "nothingToUninstall" });
    });
});

/** QSettings' Qt 4.0 QDataStream form of a QVariantMap, escaped the way its ini writer escapes it. */
function encode(value: official.QtValue): string {
    const bytes: number[] = [];
    const u32 = (n: number) => bytes.push((n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255);
    const str = (s: string) => {
        u32(s.length * 2);
        for (const ch of s) bytes.push(0, ch.charCodeAt(0));
    };
    const put = (v: official.QtValue) => {
        if (typeof v === "boolean") return u32(1), bytes.push(v ? 1 : 0);
        if (typeof v === "number") return u32(2), u32(v);
        if (typeof v === "string") return u32(10), str(v);
        if (v === null) return u32(10), u32(0xffffffff);
        if (Array.isArray(v)) {
            u32(11);
            u32(v.length);
            for (const s of v) str(String(s));
            return;
        }
        u32(8);
        u32(Object.keys(v).length);
        for (const [k, inner] of Object.entries(v)) str(k), put(inner);
    };
    put(value);
    let out = "@Variant(";
    let afterEscape = false;
    for (const b of bytes) {
        const ch = String.fromCharCode(b);
        const plain: boolean = b >= 0x20 && b < 0x7f && ch !== "\\" && ch !== "\"" && !(afterEscape && /[0-9a-fA-F]/.test(ch));
        out += plain ? ch : b === 0 ? "\\0" : `\\x${b.toString(16)}`;
        afterEscape = !plain;
    }
    return `${out})`;
}

function ini(controls: Record<string, official.QtValue>): string {
    const lines = ["[General]", "SpotifyToken=fixture-token-never-read", "", "[Device_SN_0000000000000000]", "pageNumber=2"];
    for (const [key, value] of Object.entries(controls)) lines.push(`${key}=${encode(value)}`);
    lines.push("pages\\page_0\\pageContent\\size=4", "[soundcard]", "Gain=0");
    return lines.join("\n");
}

describe("Stream Control's settings", () => {
    it("decodes the real file's escaping of an int value", () => {
        const tail = "@Variant(\\0\\0\\0\\b\\0\\0\\0\\x1\\0\\0\\0\\b\\0t\\0y\\0p\\0\\x65\\0\\0\\0\\x2\\0\\0\\0\\x1)";
        expect(official.decodeVariant(official.unescapeIniValue(tail).slice(9, -1))).toEqual({ type: 1 });
    });

    it("steps over the colors and byte arrays a customization holds", () => {
        const color = [0, 0, 0, 67, 1, 255, 255, 18, 18, 52, 52, 86, 86, 0, 0];
        const bytes = [0, 0, 0, 12, 0, 0, 0, 2, 7, 7];
        const map = [0, 0, 0, 8, 0, 0, 0, 3, 0, 0, 0, 2, 0, 99, ...color, 0, 0, 0, 2, 0, 98, ...bytes, 0, 0, 0, 2, 0, 110, 0, 0, 0, 10, 0, 0, 0, 2, 0, 65];
        expect(official.decodeVariant(Uint8Array.from(map))).toEqual({ c: null, b: null, n: "A" });
    });

    it("answers null on truncated or unknown data instead of throwing", () => {
        expect(official.decodeVariant(Uint8Array.from([0, 0, 0, 8, 0, 0, 0, 9]))).toBeNull();
        expect(official.decodeVariant(Uint8Array.from([0x40, 0x49, 0x6e, 0x76]))).toBeNull();
    });

    it("maps a multi-app knob preset to its category and lists what has no equivalent", () => {
        const text = ini({
            "pages\\page_0\\pageContent\\1\\knobDescriptor": { nameHierarchy: ["Apps", "Multi-app volume", "Volume"], targetType: 2, type: 1 },
            "pages\\page_0\\pageContent\\1\\knobCustomization": { enabled: true, name: "Calls", sources: ["Discord", "Slack"] },
            "pages\\page_0\\pageContent\\2\\knobDescriptor": { nameHierarchy: ["Apps", "Multi-app volume", "Volume"], targetType: 2, type: 1 },
            "pages\\page_0\\pageContent\\2\\knobCustomization": { name: "My mix", sources: ["Example"] },
            "pages\\page_0\\pageContent\\1\\buttonDescriptor": { nameHierarchy: ["Discord", "Mute"], target: "Mute", targetType: 36, type: 2 },
            "pages\\page_0\\pageContent\\1\\buttonCustomization": { label: "Mute", toggledState: true },
            "pages\\page_1\\pageContent\\4\\buttonDescriptor": { nameHierarchy: ["Actions", "Previous page"], targetType: 57, type: 2 },
            "pages\\page_1\\pageContent\\1\\knobDescriptor": { nameHierarchy: ["Apps", "Multi-app volume", "Volume"], targetType: 2, type: 1 },
            "pages\\page_1\\pageContent\\1\\knobCustomization": { name: "Music" }
        });
        const result = official.importStreamControl(text)!;
        expect(result.pages).toBe(2);
        expect(result.values).toEqual({ knob1: "calls" });
        expect(result.controls.find((c) => c.page === 0 && c.control === "knob" && c.slot === 1)).toMatchObject({ sources: ["Discord", "Slack"], official: "Apps > Multi-app volume" });
        expect(result.controls.filter((c) => !c.mapped).map((c) => c.official)).toEqual(["Discord > Mute", "Apps > Multi-app volume", "Actions > Previous page"]);
        expect(JSON.stringify(result)).not.toContain("fixture-token");
    });

    it("keeps every page in the layout: presets, hand-picked apps, media and page buttons, Discord", () => {
        const knob = (name: string, sources: string[]): official.QtValue[] => [{ nameHierarchy: ["Apps", "Multi-app volume", "Volume"], targetType: 2, type: 1 }, { name, sources }];
        const button = (path: string[], label: string): official.QtValue[] => [{ nameHierarchy: path, type: 2 }, { label }];
        const controls: Record<string, official.QtValue> = {};
        const put = (page: number, slot: number, kind: string, [descriptor, custom]: official.QtValue[]) => {
            controls[["pages", `page_${page}`, "pageContent", String(slot), `${kind}Descriptor`].join(BS)] = descriptor ?? null;
            controls[["pages", `page_${page}`, "pageContent", String(slot), `${kind}Customization`].join(BS)] = custom ?? null;
        };
        put(0, 1, "knob", knob("Calls", ["Discord"]));
        put(0, 2, "knob", knob("Multimedia", ["Brave Browser"]));
        put(0, 1, "button", button(["Discord", "Mute"], "Mute"));
        put(0, 2, "button", button(["Discord", "Deaf"], "Deaf"));
        put(0, 3, "button", button(["Actions", "Play / Pause media"], "Play / Pause media"));
        put(0, 4, "button", button(["Actions", "Next page"], "Next page"));
        put(1, 1, "button", button(["Actions", "Previous page"], "Previous page"));
        put(1, 2, "button", button(["Actions", "Previous media"], "Previous media"));
        put(1, 3, "button", button(["Actions", "Next media"], "Next media"));
        put(1, 4, "button", button(["Sounds", "Soundboard"], "Boom"));
        const { layout, controls: read } = official.importStreamControl(ini(controls))!;
        expect(layout.pages).toHaveLength(2);
        expect(layout.pages[0]?.knobs.slice(0, 3)).toEqual([
            { kind: "category", category: "calls", label: "Calls" },
            { kind: "apps", apps: ["Brave Browser"], label: "Multimedia" },
            { kind: "none", label: "" }
        ]);
        expect(layout.pages[0]?.buttons.map((b) => b.action)).toEqual([
            { kind: "discord", action: "mute" },
            { kind: "discord", action: "deafen" },
            { kind: "media", key: "playPause" },
            { kind: "page", to: "next" }
        ]);
        expect(layout.pages[1]?.buttons.map((b) => b.action)).toEqual([{ kind: "page", to: "previous" }, { kind: "media", key: "previous" }, { kind: "media", key: "next" }, { kind: "none" }]);
        expect(read.find((c) => c.official === "Sounds > Soundboard")?.kept).toBe(false);
        expect(layout.profiles).toEqual([]);
    });

    it("keeps no more than eight pages", () => {
        const controls: Record<string, official.QtValue> = {};
        for (let page = 0; page < 12; page++) {
            controls[["pages", `page_${page}`, "pageContent", "1", "knobDescriptor"].join(BS)] = { nameHierarchy: ["Apps", "Multi-app volume"] };
            controls[["pages", `page_${page}`, "pageContent", "1", "knobCustomization"].join(BS)] = { name: "Music" };
        }
        const result = official.importStreamControl(ini(controls))!;
        expect(result.pages).toBe(12);
        expect(result.layout.pages).toHaveLength(official.MAX_PAGES);
    });

    it("answers null for a file with no device section", () => {
        expect(official.importStreamControl("[General]\nfirst_time=false\n")).toBeNull();
    });
});
