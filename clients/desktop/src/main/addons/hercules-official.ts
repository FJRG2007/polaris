/**
 * The official Hercules software for the Stream 100, as found on a Windows
 * machine before the Polaris add-on is installed, and what each of the
 * person's choices about it would do (docs/devices/hercules-stream100.md,
 * "The official software").
 *
 * Everything here is pure: it reads the text Windows' own tools print
 * (`reg.exe query`, `tasklist`) and Stream Control's settings file, and turns a
 * choice into a list of steps. Nothing in this module runs a program, stops a
 * process or writes anywhere; the steps are carried out only after the person
 * picked one of the options, by the caller.
 */

/** One value under a registry key, as `reg.exe query /s` prints it. */
export interface RegistryKey {
    readonly path: string;
    readonly values: Readonly<Record<string, string>>;
}

/** An entry of Windows' "Installed apps" list. */
export interface InstalledEntry {
    readonly key: string;
    readonly displayName: string;
    readonly publisher: string;
    readonly version: string;
    readonly uninstallString: string;
    readonly installLocation: string;
}

/** A "start with Windows" entry under a Run key. */
export interface AutostartEntry {
    readonly hive: "HKCU" | "HKLM";
    readonly key: string;
    readonly name: string;
    readonly command: string;
}

/** What was found, or null fields where a part is missing. */
export interface OfficialSoftware {
    readonly app: InstalledEntry | null;
    readonly drivers: InstalledEntry | null;
    readonly autostart: readonly AutostartEntry[];
    readonly running: boolean;
}

export type OfficialChoice = "stop" | "uninstall" | "keep" | "cancel";

export type OfficialStep =
    | { readonly kind: "importSettings"; }
    | { readonly kind: "stopProcess"; readonly image: string; }
    | { readonly kind: "removeAutostart"; readonly entry: AutostartEntry; readonly elevated: boolean; }
    | { readonly kind: "runUninstaller"; readonly file: string; readonly args: readonly string[]; readonly signer: string; }
    | { readonly kind: "installAddon"; };

export type OfficialPlan = { readonly ok: true; readonly steps: readonly OfficialStep[]; } | { readonly ok: false; readonly reason: "cancelled" | "uninstallerRefused" | "nothingToUninstall"; };

/** Stream Control's process image; also the ownership check's name (crates/polaris-stream100/src/ownership.rs). */
export const STREAM_CONTROL_IMAGE = "Stream-control.exe";
/** The publisher names Hercules registers its packages under. */
const PUBLISHERS = ["hercules", "guillemot corporation"];
/** Authenticode signer the vendor uninstaller has to carry. */
export const HERCULES_SIGNER = "Guillemot Corporation";
const MAX_REG_TEXT = 4_000_000;
const STARTS_STREAM_CONTROL = /(^|[\\/"])stream-control\.exe("|\s|$)/i;

/**
 * Parses `reg.exe query <key> /s` output: a key path on its own line, then its
 * values as `    Name    REG_TYPE    Data`. The unnamed value is `(Default)`.
 */
export function parseRegQuery(text: string): RegistryKey[] {
    const keys: { path: string; values: Record<string, string>; }[] = [];
    for (const raw of text.slice(0, MAX_REG_TEXT).split(/\r?\n/)) {
        if (/^HKEY_[A-Z_]+(\\|$)/.test(raw)) {
            keys.push({ path: raw.trim(), values: {} });
            continue;
        }
        const match = /^ {4}(.+?) {4}(REG_[A-Z_]+)(?: {4}(.*))?$/.exec(raw);
        const current = keys.at(-1);
        if (match && current) current.values[match[1] ?? ""] = match[3] ?? "";
    }
    return keys;
}

function lastSegment(path: string): string {
    return path.slice(path.lastIndexOf("\\") + 1);
}

/** Entries of the uninstall keys whose publisher is Hercules. */
export function installedHercules(keys: readonly RegistryKey[]): InstalledEntry[] {
    return keys
        .filter((key) => /\\Uninstall\\[^\\]+$/i.test(key.path))
        .filter((key) => PUBLISHERS.includes((key.values.Publisher ?? "").trim().toLowerCase()))
        .map((key) => ({
            key: lastSegment(key.path),
            displayName: key.values.DisplayName ?? "",
            publisher: key.values.Publisher ?? "",
            version: key.values.DisplayVersion ?? "",
            uninstallString: key.values.UninstallString ?? "",
            installLocation: key.values.InstallLocation ?? ""
        }));
}

/** Run-key values that start Stream Control. */
export function herculesAutostart(keys: readonly RegistryKey[]): AutostartEntry[] {
    const out: AutostartEntry[] = [];
    for (const key of keys) {
        if (!/\\CurrentVersion\\Run$/i.test(key.path)) continue;
        const hive = key.path.startsWith("HKEY_CURRENT_USER") ? "HKCU" : key.path.startsWith("HKEY_LOCAL_MACHINE") ? "HKLM" : null;
        if (!hive) continue;
        for (const [name, command] of Object.entries(key.values)) {
            // Hercules registers the path unquoted, spaces and all, so the
            // command is matched on the image name ending a path, not split.
            if (STARTS_STREAM_CONTROL.test(command)) out.push({ hive, key: key.path, name, command });
        }
    }
    return out;
}

/** Whether `tasklist /fo csv /nh` output lists Stream Control. */
export function streamControlRunning(tasklistCsv: string): boolean {
    return tasklistCsv.split(/\r?\n/).some((line) => line.trim().toLowerCase().startsWith(`"${STREAM_CONTROL_IMAGE.toLowerCase()}"`));
}

/** The pieces found, or null when nothing of the official software is on this machine. */
export function findOfficial(keys: readonly RegistryKey[], tasklistCsv: string): OfficialSoftware | null {
    const installed = installedHercules(keys);
    const app = installed.find((entry) => /stream control/i.test(entry.displayName)) ?? null;
    const drivers = installed.find((entry) => /^HSM Series drivers$/i.test(entry.displayName.trim())) ?? null;
    const autostart = herculesAutostart(keys);
    const running = streamControlRunning(tasklistCsv);
    return app || drivers || autostart.length || running ? { app, drivers, autostart, running } : null;
}

/**
 * Splits a command line the way Windows' `CommandLineToArgvW` does: spaces
 * separate arguments outside quotes, `2n` backslashes before a quote are `n`
 * backslashes, `2n+1` are `n` and a literal quote.
 */
export function splitCommandLine(line: string): string[] {
    const args: string[] = [];
    let current = "";
    let quoted = false;
    let started = false;
    for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (ch === "\\") {
            let slashes = 0;
            while (line[i] === "\\") {
                slashes++;
                i++;
            }
            if (line[i] === "\"") {
                current += "\\".repeat(slashes >> 1);
                if (slashes % 2) current += "\"";
                else {
                    quoted = !quoted;
                }
            } else {
                current += "\\".repeat(slashes);
                i--;
            }
            started = true;
        } else if (ch === "\"") {
            quoted = !quoted;
            started = true;
        } else if ((ch === " " || ch === "\t") && !quoted) {
            if (started) args.push(current);
            current = "";
            started = false;
        } else {
            current += ch;
            started = true;
        }
    }
    if (started) args.push(current);
    return args;
}

/** Flags the InstallShield setup.exe of these packages takes, and nothing else. */
const UNINSTALL_FLAGS = /^(-runfromtemp|-removeonly|-remove|-l0x[0-9a-f]{4})$/i;
const GUID = /^\{[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}\}$/i;

/**
 * The vendor's uninstaller for an entry, or null when its UninstallString is
 * not exactly the InstallShield setup.exe kept for that package's own product
 * code: an absolute path under `<Program Files (x86)>\InstallShield
 * Installation Information\<the entry's key>\setup.exe`, no `..`, and only the
 * removal flags. Anything else (a script, another folder, an extra argument)
 * is refused rather than run. The signature is checked by the caller before
 * the file starts (`signer`).
 */
export function vetUninstaller(entry: InstalledEntry, programFilesX86: string): { file: string; args: string[]; } | null {
    if (!GUID.test(entry.key) || !PUBLISHERS.includes(entry.publisher.trim().toLowerCase())) return null;
    const [file, ...args] = splitCommandLine(entry.uninstallString);
    if (!file || /[\0-\x1f]/.test(entry.uninstallString)) return null;
    const expected = `${programFilesX86.replace(/[\\/]+$/, "")}\\InstallShield Installation Information\\${entry.key}\\setup.exe`;
    if (file.toLowerCase() !== expected.toLowerCase() || file.includes("..")) return null;
    if (!args.every((arg) => UNINSTALL_FLAGS.test(arg))) return null;
    return { file, args };
}

/**
 * The steps a choice takes. The person's settings are always imported first,
 * before anything is stopped or removed; `cancel` takes none and installs
 * nothing. Uninstalling removes the app, then its drivers, each through its
 * own vetted uninstaller; one that fails the check refuses the whole choice.
 */
export function planChoice(choice: OfficialChoice, found: OfficialSoftware, programFilesX86: string): OfficialPlan {
    if (choice === "cancel") return { ok: false, reason: "cancelled" };
    const steps: OfficialStep[] = [{ kind: "importSettings" }];
    if (choice === "stop" || choice === "uninstall") {
        if (found.running) steps.push({ kind: "stopProcess", image: STREAM_CONTROL_IMAGE });
    }
    if (choice === "stop") {
        for (const entry of found.autostart) steps.push({ kind: "removeAutostart", entry, elevated: entry.hive === "HKLM" });
    }
    if (choice === "uninstall") {
        const packages = [found.app, found.drivers].filter((entry): entry is InstalledEntry => entry !== null);
        if (!packages.length) return { ok: false, reason: "nothingToUninstall" };
        for (const entry of packages) {
            const vetted = vetUninstaller(entry, programFilesX86);
            if (!vetted) return { ok: false, reason: "uninstallerRefused" };
            steps.push({ kind: "runUninstaller", ...vetted, signer: HERCULES_SIGNER });
        }
    }
    steps.push({ kind: "installAddon" });
    return { ok: true, steps };
}

/** A value of Qt's QVariant, as QSettings stores it (QDataStream, Qt 4.0 format). */
export type QtValue = boolean | number | string | null | QtValue[] | { [key: string]: QtValue; };

const MAX_DEPTH = 8;

/** The bytes of one QSettings ini value: undoes its `\0`, `\xNN`, `\n`... escapes. */
export function unescapeIniValue(value: string): Uint8Array {
    let text = value.trim();
    if (text.length >= 2 && text.startsWith("\"") && text.endsWith("\"")) text = text.slice(1, -1);
    const out: number[] = [];
    const named: Record<string, number> = { a: 7, b: 8, f: 12, n: 10, r: 13, t: 9, v: 11, "\\": 92, "\"": 34, "'": 39, "?": 63 };
    for (let i = 0; i < text.length; i++) {
        const ch = text.charAt(i);
        if (ch !== "\\" || i + 1 >= text.length) {
            out.push(text.charCodeAt(i) & 0xff);
            continue;
        }
        const next = text.charAt(i + 1);
        if (next === "x") {
            const hex = /^[0-9a-fA-F]{1,4}/.exec(text.slice(i + 2))?.[0] ?? "";
            out.push(Number.parseInt(hex || "0", 16) & 0xff);
            i += 1 + hex.length;
        } else if (/[0-7]/.test(next)) {
            const oct = /^[0-7]{1,3}/.exec(text.slice(i + 1))?.[0] ?? "0";
            out.push(Number.parseInt(oct, 8) & 0xff);
            i += oct.length;
        } else {
            out.push(named[next] ?? next.charCodeAt(0) & 0xff);
            i += 1;
        }
    }
    return Uint8Array.from(out);
}

/**
 * Decodes a `@Variant(...)` value. QSettings streams it with
 * `QDataStream::Qt_4_0`, where a variant is its type id and the value, with no
 * null flag. Unknown types and truncated data answer null rather than throw.
 */
export function decodeVariant(bytes: Uint8Array): QtValue {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let offset = 0;
    const u32 = () => {
        if (offset + 4 > view.byteLength) throw new RangeError("truncated");
        const v = view.getUint32(offset);
        offset += 4;
        return v;
    };
    const str = (): string | null => {
        const length = u32();
        if (length === 0xffffffff) return null;
        if (length % 2 || offset + length > view.byteLength) throw new RangeError("bad string");
        let s = "";
        for (let i = 0; i < length; i += 2) s += String.fromCharCode(view.getUint16(offset + i));
        offset += length;
        return s;
    };
    const value = (depth: number): QtValue => {
        if (depth > MAX_DEPTH) throw new RangeError("too deep");
        const type = u32();
        switch (type) {
            case 0: return null;
            case 1: {
                if (offset + 1 > view.byteLength) throw new RangeError("truncated");
                return view.getUint8(offset++) !== 0;
            }
            case 2: return u32() | 0;
            case 3: return u32();
            case 6: {
                if (offset + 8 > view.byteLength) throw new RangeError("truncated");
                const v = view.getFloat64(offset);
                offset += 8;
                return v;
            }
            case 10: return str();
            // QByteArray and QColor (Qt 4.0 form: spec, alpha, r, g, b, pad):
            // skipped, nothing imported needs them.
            case 12: {
                const length = u32();
                if (length !== 0xffffffff) offset += length;
                if (offset > view.byteLength) throw new RangeError("truncated");
                return null;
            }
            case 67: {
                offset += 11;
                if (offset > view.byteLength) throw new RangeError("truncated");
                return null;
            }
            case 8: {
                const map: Record<string, QtValue> = {};
                for (let n = u32(); n > 0; n--) {
                    const key = str() ?? "";
                    map[key] = value(depth + 1);
                }
                return map;
            }
            case 9: {
                const list: QtValue[] = [];
                for (let n = u32(); n > 0; n--) list.push(value(depth + 1));
                return list;
            }
            case 11: {
                const list: QtValue[] = [];
                for (let n = u32(); n > 0; n--) list.push(str());
                return list;
            }
            default: throw new RangeError(`type ${type}`);
        }
    };
    try {
        return value(0);
    } catch {
        return null;
    }
}

/** `[section]` -> key -> raw value, as QSettings writes its ini file. */
export function parseIni(text: string): Map<string, Map<string, string>> {
    const sections = new Map<string, Map<string, string>>();
    let current = new Map<string, string>();
    sections.set("General", current);
    for (const line of text.split(/\r?\n/)) {
        const section = /^\[(.+)\]\s*$/.exec(line);
        if (section) {
            current = sections.get(section[1] ?? "") ?? new Map();
            sections.set(section[1] ?? "", current);
            continue;
        }
        const eq = line.indexOf("=");
        if (eq > 0) current.set(line.slice(0, eq).trim(), line.slice(eq + 1));
    }
    return sections;
}

function variantOf(raw: string | undefined): QtValue {
    if (!raw) return null;
    const bytes = unescapeIniValue(raw);
    const prefix = "@Variant(";
    const head = String.fromCharCode(...bytes.slice(0, prefix.length));
    if (head !== prefix || bytes.at(-1) !== 0x29) return null;
    return decodeVariant(bytes.slice(prefix.length, -1));
}

function record(value: QtValue): Record<string, QtValue> {
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function texts(value: QtValue): string[] {
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

/** One control of one Stream Control page, with what Polaris made of it. */
export interface ImportedControl {
    readonly page: number;
    readonly slot: number;
    readonly control: "knob" | "button";
    /** Stream Control's own wording, such as `Apps > Multi-app volume` or `Discord > Mute`. */
    readonly official: string;
    readonly name: string;
    readonly sources: readonly string[];
    /** The add-on setting and value it became, or null when Polaris has no equivalent yet. */
    readonly mapped: { readonly key: string; readonly value: string; } | null;
    /** Whether it was kept in the imported layout (`layout`), for when the add-on can do it. */
    readonly kept: boolean;
}

/** What a knob of an imported page follows (crates/polaris-stream100/src/settings.rs, `PageKnob`). */
export type LayoutKnob =
    | { readonly kind: "category"; readonly category: string; readonly label: string; }
    | { readonly kind: "apps"; readonly apps: readonly string[]; readonly label: string; }
    | { readonly kind: "program"; readonly program: string; readonly label: string; }
    | { readonly kind: "microphone"; readonly label: string; }
    | { readonly kind: "output"; readonly label: string; }
    | { readonly kind: "none"; readonly label: string; };

/** What a button of an imported page does (settings.rs, `PageAction`). */
export type LayoutAction =
    | { readonly kind: "action"; readonly action: string; }
    | { readonly kind: "media"; readonly key: "playPause" | "next" | "previous"; }
    | { readonly kind: "page"; readonly to: "next" | "previous"; }
    | { readonly kind: "discord"; readonly action: "mute" | "deafen"; }
    | { readonly kind: "none"; };

export interface LayoutButton {
    readonly action: LayoutAction;
    readonly label: string;
    /** The label while the button is on; null when it keeps one label. */
    readonly toggledLabel: string | null;
}

export interface LayoutPage {
    readonly knobs: readonly LayoutKnob[];
    readonly buttons: readonly LayoutButton[];
}

/** A set of pages that comes up while one of its apps is in front (settings.rs, `Profile`). */
export interface LayoutProfile {
    readonly name: string;
    readonly apps: readonly string[];
    readonly page: number;
}

/** Every page as Stream Control had it, in the add-on's own model (settings.rs `Settings.pages`/`profiles`). */
export interface Layout {
    readonly pages: readonly LayoutPage[];
    readonly profiles: readonly LayoutProfile[];
}

export interface StreamControlImport {
    readonly pages: number;
    readonly controls: readonly ImportedControl[];
    /** Flat add-on values (`knob1`, `button2`...), from page 1 only: the add-on has one page today. */
    readonly values: Readonly<Record<string, string>>;
    readonly layout: Layout;
}

/** Stream Control's knob preset names, to the add-on's knob categories. */
const KNOB_PRESETS: Readonly<Record<string, string>> = { calls: "calls", chat: "calls", music: "music", games: "games", gaming: "games", browser: "browser", system: "system" };

function knobValue(hierarchy: string[], name: string): string | null {
    if (hierarchy[0] !== "Apps" || hierarchy[1] !== "Multi-app volume") return null;
    return KNOB_PRESETS[name.trim().toLowerCase()] ?? null;
}

/** The largest number of pages kept: Stream Control offers eight. */
export const MAX_PAGES = 8;
const MAX_LABEL = 40;
const MAX_APPS = 64;

/** Stream Control's button menu paths (`nameHierarchy`, read from a real 2.05.8 settings file), to the add-on's actions. */
const BUTTON_ACTIONS: Readonly<Record<string, LayoutAction>> = {
    "Actions > Play / Pause media": { kind: "media", key: "playPause" },
    "Actions > Next media": { kind: "media", key: "next" },
    "Actions > Previous media": { kind: "media", key: "previous" },
    "Actions > Next page": { kind: "page", to: "next" },
    "Actions > Previous page": { kind: "page", to: "previous" },
    "Discord > Mute": { kind: "discord", action: "mute" },
    "Discord > Deaf": { kind: "discord", action: "deafen" }
};

function clip(text: string, max: number): string {
    return text.replace(/[\0-\x1f]/g, "").trim().slice(0, max);
}

/**
 * A knob in the layout: a preset name is its category; any other multi-app
 * knob is the apps hand-picked for it (one app is a list of one).
 */
function layoutKnob(hierarchy: readonly string[], name: string, sources: readonly string[]): LayoutKnob | null {
    const label = clip(name, MAX_LABEL);
    if (hierarchy[0] !== "Apps" || hierarchy[1] !== "Multi-app volume") return null;
    const category = KNOB_PRESETS[name.trim().toLowerCase()];
    if (category) return { kind: "category", category, label };
    const apps = sources.map((app) => clip(app, 120)).filter(Boolean).slice(0, MAX_APPS);
    return apps.length ? { kind: "apps", apps, label } : null;
}

/**
 * Reads Stream Control's settings file (`%APPDATA%\Hercules\Stream
 * Control\Stream Control.ini`) for the device section: every page's knobs
 * and buttons, and the add-on values the ones Polaris has an equivalent for
 * become. Only `pages\...` keys are read: the file also holds the person's
 * Discord, Spotify and OBS tokens, which are never parsed or kept.
 */
export function importStreamControl(text: string): StreamControlImport | null {
    const sections = parseIni(text);
    const device = [...sections.entries()].find(([name]) => /^Device_SN_/.test(name))?.[1];
    if (!device) return null;
    const controls: ImportedControl[] = [];
    const pageIndexes = new Set<number>();
    const pages = new Map<number, { knobs: (LayoutKnob | null)[]; buttons: (LayoutButton | null)[]; }>();
    for (const key of device.keys()) {
        const match = /^pages\\page_(\d{1,2})\\pageContent\\([1-4])\\(knob|button)Descriptor$/.exec(key);
        if (!match) continue;
        const page = Number(match[1]);
        const slot = Number(match[2]);
        const control = match[3] as "knob" | "button";
        pageIndexes.add(page);
        const descriptor = record(variantOf(device.get(key)));
        const custom = record(variantOf(device.get(key.replace("Descriptor", "Customization"))));
        const hierarchy = texts(descriptor.nameHierarchy ?? null);
        if (!hierarchy.length) continue;
        const name = typeof custom.name === "string" ? custom.name : typeof custom.label === "string" ? custom.label : "";
        const value = control === "knob" ? knobValue(hierarchy, name) : null;
        const official = hierarchy.slice(0, 2).join(" > ");
        const sources = texts(custom.sources ?? null).slice(0, MAX_APPS);
        const knob = control === "knob" ? layoutKnob(hierarchy, name, sources) : null;
        const action = control === "button" ? (BUTTON_ACTIONS[official] ?? null) : null;
        if (pageIndexes.size <= MAX_PAGES || pages.has(page)) {
            const slots = pages.get(page) ?? { knobs: [null, null, null, null], buttons: [null, null, null, null] };
            pages.set(page, slots);
            if (knob) slots.knobs[slot - 1] = knob;
            if (action) slots.buttons[slot - 1] = { action, label: clip(name, MAX_LABEL), toggledLabel: null };
        }
        controls.push({ page, slot, control, official, name, sources, mapped: value ? { key: `${control}${slot}`, value } : null, kept: Boolean(knob || action) });
    }
    controls.sort((a, b) => a.page - b.page || a.control.localeCompare(b.control) || a.slot - b.slot);
    const first = Math.min(...pageIndexes);
    const values: Record<string, string> = {};
    for (const c of controls) if (c.page === first && c.mapped) values[c.mapped.key] = c.mapped.value;
    const layout: Layout = {
        pages: [...pages.entries()]
            .sort(([a], [b]) => a - b)
            .slice(0, MAX_PAGES)
            .map(([, slots]) => ({
                knobs: slots.knobs.map((knob) => knob ?? { kind: "none", label: "" }),
                buttons: slots.buttons.map((button) => button ?? { action: { kind: "none" }, label: "", toggledLabel: null })
            })),
        // Stream Control 2.05.8 writes `profiles=@Invalid()` until one is
        // made; no real profile has been read, so none is guessed at.
        profiles: []
    };
    return { pages: pageIndexes.size, controls, values, layout };
}
