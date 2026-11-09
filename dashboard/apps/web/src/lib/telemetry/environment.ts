/**
 * Where an event happened, as the four facts somebody reads first.
 *
 * The contexts a client sends are an open map, drawn in full further down the
 * event. Above them Sentry draws a strip - runtime, operating system, browser,
 * device, each with its mark and its version - because "only on Alpine" or
 * "only in Safari 17" is the answer to most crash reports, and it should not
 * take reading four panels to see it.
 *
 * Pure, so the screen and the tests read the same thing. Every name and key is
 * matched case-insensitively: Sentry's own SDKs write `os.name` as `Ubuntu`,
 * `macOS` or `Windows`, older ones and other clients write `linux`, `darwin` or
 * `Debian GNU/Linux`, and the browser SDK sends what it parsed from the user
 * agent as `client_os` rather than `os`.
 */

import type { ContextGroup } from "@polaris/core";

/** A mark the screen can draw. Each one is a real logo in `platform-marks`. */
export const PLATFORM_MARKS = [
    "node",
    "bun",
    "deno",
    "python",
    "go",
    "java",
    "dotnet",
    "php",
    "ruby",
    "rust",
    "elixir",
    "kotlin",
    "ubuntu",
    "debian",
    "alpine",
    "fedora",
    "centos",
    "redhat",
    "arch",
    "mint",
    "opensuse",
    "rocky",
    "alma",
    "nixos",
    "manjaro",
    "raspberrypi",
    "linux",
    "windows",
    "apple",
    "android",
    "chrome",
    "firefox",
    "safari",
    "edge",
    "opera",
    "brave"
] as const;

export type PlatformMark = (typeof PLATFORM_MARKS)[number];

export type EnvironmentKind = "runtime" | "os" | "browser" | "device";

export interface EnvironmentFact {
    readonly kind: EnvironmentKind;
    /** The name as the client sent it, or as the distribution calls itself. */
    readonly name: string;
    readonly version: string | null;
    /** The one more thing worth a glance: the kernel under a distribution, the
     *  architecture of a device. */
    readonly detail: string | null;
    readonly mark: PlatformMark | null;
    /** A phone or a tablet rather than a computer, for the device's glyph. */
    readonly mobile: boolean;
}

/** First match wins, so the specific names come before the ones they contain
 *  ("Linux Mint" before "Linux", "Chrome" after "Edge" and "Opera", whose user
 *  agents name Chrome too). */
const RUNTIME_MARKS: readonly (readonly [RegExp, PlatformMark])[] = [
    [/^(node|node\.?js)$/, "node"],
    [/^bun$/, "bun"],
    [/^deno$/, "deno"],
    [/python|pypy/, "python"],
    [/^go(lang)?$/, "go"],
    [/java(?!script)|openjdk|jvm|hotspot|graalvm/, "java"],
    [/\.net|dotnet|coreclr|^mono$/, "dotnet"],
    [/^php|hhvm/, "php"],
    [/ruby|jruby/, "ruby"],
    [/^rust/, "rust"],
    [/elixir|erlang|beam/, "elixir"],
    [/kotlin/, "kotlin"]
];

const OS_MARKS: readonly (readonly [RegExp, PlatformMark])[] = [
    [/ubuntu/, "ubuntu"],
    [/linux mint|^mint$/, "mint"],
    [/debian/, "debian"],
    [/raspbian|raspberry pi/, "raspberrypi"],
    [/alpine/, "alpine"],
    [/fedora/, "fedora"],
    [/centos/, "centos"],
    [/red ?hat|^rhel/, "redhat"],
    [/rocky/, "rocky"],
    [/alma/, "alma"],
    [/arch ?linux|^arch$/, "arch"],
    [/manjaro/, "manjaro"],
    [/suse/, "opensuse"],
    [/nixos/, "nixos"],
    [/windows|^win32$/, "windows"],
    [/^(macos|mac os|os x|darwin|ios|ipados|tvos|watchos|visionos)/, "apple"],
    [/android/, "android"],
    // Anything else that is a Linux - Amazon Linux, Gentoo, a kernel with no
    // distribution named - gets the penguin, and only then.
    [/linux|gnu/, "linux"]
];

const BROWSER_MARKS: readonly (readonly [RegExp, PlatformMark])[] = [
    [/edge/, "edge"],
    [/opera|opr/, "opera"],
    [/brave/, "brave"],
    [/firefox/, "firefox"],
    [/chrom/, "chrome"],
    [/safari/, "safari"]
];

const MOBILE_OS = /^(ios|ipados|android|watchos)/;

function markOf(
    table: readonly (readonly [RegExp, PlatformMark])[],
    name: string
): PlatformMark | null {
    const said = name.trim().toLowerCase();
    if (!said) return null;
    for (const [pattern, mark] of table) if (pattern.test(said)) return mark;
    return null;
}

/** The fields of one group, keyed in lower case. */
function groupOf(
    contexts: readonly ContextGroup[],
    ...names: string[]
): Map<string, string> | null {
    for (const name of names) {
        const group = contexts.find((one) => one.name.toLowerCase() === name);
        if (!group) continue;
        const fields = new Map<string, string>();
        for (const field of group.fields) {
            const value = field.value.trim();
            if (value) fields.set(field.key.toLowerCase(), value);
        }
        if (fields.size > 0) return fields;
    }
    return null;
}

/** A tag, case-insensitively: `os.name`, `OS.Name` and `os` are one fact. */
function tagOf(tags: Readonly<Record<string, string>>, ...names: string[]): string | null {
    const lowered = new Map(
        Object.entries(tags).map(([key, value]) => [key.toLowerCase(), value.trim()])
    );
    for (const name of names) {
        const value = lowered.get(name);
        if (value) return value;
    }
    return null;
}

/** "Chrome 120.0.0" from a tag that is one string; the name and the rest. */
function splitTag(value: string): { name: string; version: string | null } {
    const match = /^(.*?)\s+v?(\d[\w.\-+]*)$/.exec(value.trim());
    return match?.[1]
        ? { name: match[1], version: match[2] ?? null }
        : { name: value, version: null };
}

function runtimeFact(
    contexts: readonly ContextGroup[],
    tags: Readonly<Record<string, string>>
): EnvironmentFact | null {
    const group = groupOf(contexts, "runtime");
    const named = group?.get("name") ?? tagOf(tags, "runtime.name");
    const raw = group?.get("raw_description") ?? tagOf(tags, "runtime");
    const read = named
        ? { name: named, version: group?.get("version") ?? tagOf(tags, "runtime.version") }
        : raw
          ? splitTag(raw)
          : null;
    if (!read) return null;
    const mark = markOf(RUNTIME_MARKS, read.name);
    return {
        kind: "runtime",
        // `node` as a node SDK writes it reads better as the project calls itself.
        name: mark === "node" ? "Node.js" : read.name,
        version: read.version?.replace(/^v(?=\d)/, "") ?? null,
        detail: null,
        mark,
        mobile: false
    };
}

function osFact(
    contexts: readonly ContextGroup[],
    tags: Readonly<Record<string, string>>
): EnvironmentFact | null {
    // The server's own system first; a browser event has only the one parsed
    // from its user agent.
    const group = groupOf(contexts, "os", "client_os");
    const tagged = tagOf(tags, "os.name", "client_os.name");
    const raw = group?.get("raw_description") ?? tagOf(tags, "os", "client_os");
    let name = group?.get("name") ?? tagged ?? null;
    let version = group?.get("version") ?? tagOf(tags, "os.version", "client_os.version");
    if (!name && raw) {
        const said = splitTag(raw);
        name = said.name;
        version = version ?? said.version;
    }
    if (!name) return null;

    // A bare "Linux" is the kernel's name, not the system's. When the client
    // also said which distribution, that is what is named.
    let mark = markOf(OS_MARKS, name);
    if (mark === "linux" && raw) {
        const distro = markOf(OS_MARKS, raw);
        if (distro && distro !== "linux") {
            mark = distro;
            const said = splitTag(raw);
            name = said.name;
            version = said.version;
        }
    }
    const kernel = group?.get("kernel_version") ?? tagOf(tags, "os.kernel_version");
    const lowered = name.toLowerCase();
    return {
        kind: "os",
        name: lowered === "darwin" ? "macOS" : lowered === "win32" ? "Windows" : name,
        version: version ?? null,
        detail: kernel && kernel !== version ? kernel : null,
        mark,
        mobile: MOBILE_OS.test(lowered)
    };
}

function browserFact(
    contexts: readonly ContextGroup[],
    tags: Readonly<Record<string, string>>
): EnvironmentFact | null {
    const group = groupOf(contexts, "browser");
    const tagged = tagOf(tags, "browser.name");
    const raw = tagOf(tags, "browser");
    const read = group?.get("name")
        ? { name: group.get("name") as string, version: group.get("version") ?? null }
        : tagged
          ? { name: tagged, version: tagOf(tags, "browser.version") }
          : raw
            ? splitTag(raw)
            : null;
    if (!read) return null;
    return {
        kind: "browser",
        name: read.name,
        version: read.version ?? null,
        detail: null,
        mark: markOf(BROWSER_MARKS, read.name),
        mobile: /mobile/i.test(read.name)
    };
}

function deviceFact(
    contexts: readonly ContextGroup[],
    tags: Readonly<Record<string, string>>,
    mobileOs: boolean
): EnvironmentFact | null {
    const group = groupOf(contexts, "device");
    const os = groupOf(contexts, "os");
    const name =
        group?.get("model") ??
        group?.get("name") ??
        group?.get("family") ??
        group?.get("brand") ??
        tagOf(tags, "device", "device.family");
    const arch = group?.get("arch") ?? os?.get("arch") ?? null;
    if (!name && !arch) return null;
    const family = (group?.get("family") ?? "").toLowerCase();
    return {
        kind: "device",
        name: name ?? arch ?? "",
        version: null,
        detail: name ? arch : null,
        mark: null,
        mobile: mobileOs || /phone|tablet|ipad|mobile/.test(family)
    };
}

/** The strip, in the order Sentry draws it. A fact the client never sent is
 *  left out rather than drawn as unknown. */
export function environmentOf(
    contexts: readonly ContextGroup[],
    tags: Readonly<Record<string, string>> = {}
): EnvironmentFact[] {
    const os = osFact(contexts, tags);
    return [
        runtimeFact(contexts, tags),
        os,
        browserFact(contexts, tags),
        deviceFact(contexts, tags, os?.mobile ?? false)
    ].filter((fact): fact is EnvironmentFact => fact !== null);
}

/** A project's platform as a Sentry client names it (`node`, `python`,
 *  `javascript`...), as the runtime mark it is written in, or null. */
export function platformMark(platform: string | null | undefined): PlatformMark | null {
    if (!platform) return null;
    const said = platform.toLowerCase();
    if (said === "csharp") return "dotnet";
    if (said === "cocoa") return "apple";
    return markOf(RUNTIME_MARKS, said);
}

/** What `/etc/os-release` says the system is: its `NAME`, `VERSION_ID` and
 *  `PRETTY_NAME`, or null when it names none. The format is shell assignments,
 *  optionally quoted (https://www.freedesktop.org/software/systemd/man/os-release.html). */
export function readOsRelease(
    text: string
): { name: string; version: string | null; pretty: string | null } | null {
    const values = new Map<string, string>();
    for (const line of text.split(/\r?\n/)) {
        const match = /^\s*([A-Z0-9_]+)=(.*)$/.exec(line);
        if (!match?.[1]) continue;
        let value = (match[2] ?? "").trim();
        if (/^(["']).*\1$/.test(value)) value = value.slice(1, -1);
        values.set(match[1], value.replace(/\\(["'\\$`])/g, "$1").slice(0, 120));
    }
    const name = values.get("NAME") || values.get("ID");
    if (!name) return null;
    return {
        name,
        version: values.get("VERSION_ID") || null,
        pretty: values.get("PRETTY_NAME") || null
    };
}
