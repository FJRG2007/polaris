/**
 * Holding a mod loader at the version a server already runs.
 *
 * Left on "latest", the image asks the loader's own repository which version that
 * is every single time the server starts, before anything else happens - even
 * when the answer is the version already sitting on disk. That makes every start
 * depend on a third party's web server being up and answering in a format the
 * image's helper can read. On 2026-10-03 NeoForge's repository added one
 * attribute to its `maven-metadata.xml`, the helper refused the document, and
 * every NeoForge server left on "latest" crash-looped on its next start with its
 * files intact and perfectly runnable.
 *
 * The helper already has the way out: given a specific version that matches the
 * manifest it wrote when it installed one, it answers from that manifest and asks
 * nobody (`ForgeInstallerResolver.resolve`, `NeoForgeInstallerResolver.resolve`,
 * `FabricMetaClient.resolve*Version`, `QuiltInstaller.resolveLoaderVersion` in
 * itzg/mc-image-helper). So the version is read out of that manifest and written
 * into the variable the image passes to the helper, and from then on a restart
 * never resolves "latest" over the network. Updating the loader becomes something
 * somebody does on purpose.
 *
 * Paper, Purpur and the other plugin servers are deliberately not here. Their
 * helper asks the download API for the build's metadata on every start whatever
 * build it is given (`PaperDownloadsClient.download`), so pinning a build would
 * remove no network call - it would only stop the security fixes a new build
 * brings.
 *
 * Pure: the service reads the files and writes the variables.
 */

/** The software this pins, as the image's `TYPE`. */
export type PinnableType = "NEOFORGE" | "FORGE" | "FABRIC" | "QUILT";

/** What one loader's pin is made of. Every name here is the image's own (the
 *  `start-deploy*` scripts) or the helper's (its manifest classes). */
interface LoaderSpec {
    readonly type: PinnableType;
    readonly name: string;
    /** The file the helper writes into `/data` when it installs the loader:
     *  `.<id>-manifest.json` (`Manifests.buildManifestPath`). */
    readonly manifest: string;
    /** The variable the loader version is passed in. */
    readonly key: string;
    /** Older spellings the image still reads when the main one is unset. */
    readonly legacyKeys: readonly string[];
    /** Values that mean "whatever is newest", resolved over the network. */
    readonly moving: readonly string[];
    /** Variables that replace the download altogether (an installer or a launcher
     *  of somebody's own). With one set there is nothing to resolve and nothing
     *  this may override. */
    readonly custom: readonly string[];
    /** The release and the variables to write, out of the parsed manifest. */
    readonly read: (manifest: Record<string, unknown>, env: EnvReader) => ManifestPin | null;
}

/** The release a manifest was installed for, and what to write to hold it. */
interface ManifestPin {
    readonly minecraft: string;
    readonly version: string;
    readonly vars: Readonly<Record<string, string>>;
}

type EnvReader = (key: string) => string;

/** A version string as it may go into a variable: what the loaders publish, and
 *  nothing a shell or a control character could make more of. The manifest is a
 *  file inside the container, so it is not trusted to be what it claims. */
const VERSION_SHAPE = /^[A-Za-z0-9][A-Za-z0-9.+_-]{0,63}$/;

function versionIn(value: unknown): string | null {
    return typeof value === "string" && VERSION_SHAPE.test(value) ? value : null;
}

/** Forge and NeoForge share one manifest class (`ForgeManifest`): the NeoForge
 *  version is kept in `forgeVersion` too. */
function forgeLike(key: string) {
    return (manifest: Record<string, unknown>): ManifestPin | null => {
        const minecraft = versionIn(manifest.minecraftVersion);
        const version = versionIn(manifest.forgeVersion);
        if (!minecraft || !version) return null;
        return { minecraft, version, vars: { [key]: version } };
    };
}

const LOADERS: readonly LoaderSpec[] = [
    {
        type: "NEOFORGE",
        name: "NeoForge",
        manifest: ".neoforge-manifest.json",
        key: "NEOFORGE_VERSION",
        legacyKeys: [],
        moving: ["", "latest"],
        custom: ["NEOFORGE_INSTALLER"],
        read: forgeLike("NEOFORGE_VERSION")
    },
    {
        type: "FORGE",
        name: "Forge",
        manifest: ".forge-manifest.json",
        key: "FORGE_VERSION",
        legacyKeys: ["FORGEVERSION"],
        moving: ["", "latest", "recommended"],
        custom: ["FORGE_INSTALLER", "FORGE_INSTALLER_URL"],
        read: forgeLike("FORGE_VERSION")
    },
    {
        type: "FABRIC",
        name: "Fabric",
        manifest: ".fabric-manifest.json",
        key: "FABRIC_LOADER_VERSION",
        legacyKeys: [],
        moving: ["", "latest"],
        custom: ["FABRIC_LAUNCHER", "FABRIC_LAUNCHER_URL"],
        // The installer is resolved over the network too when it is left on
        // latest, so it is held beside the loader - unless somebody chose one.
        read: (manifest, env) => {
            const origin = manifest.origin;
            if (typeof origin !== "object" || origin === null) return null;
            const versions = origin as Record<string, unknown>;
            if (versions["@type"] !== undefined && versions["@type"] !== "versions") return null;
            const minecraft = versionIn(versions.game);
            const version = versionIn(versions.loader);
            if (!minecraft || !version) return null;
            const installer = versionIn(versions.installer);
            const chosenInstaller = env("FABRIC_LAUNCHER_VERSION") || env("FABRIC_INSTALLER_VERSION");
            const vars: Record<string, string> = { FABRIC_LOADER_VERSION: version };
            if (installer && isMoving(chosenInstaller, ["", "latest"])) {
                vars.FABRIC_LAUNCHER_VERSION = installer;
            }
            return { minecraft, version, vars };
        }
    },
    {
        type: "QUILT",
        name: "Quilt",
        manifest: ".quilt-manifest.json",
        key: "QUILT_LOADER_VERSION",
        legacyKeys: [],
        moving: ["", "latest"],
        custom: ["QUILT_LAUNCHER", "QUILT_LAUNCHER_URL", "QUILT_INSTALLER_URL"],
        read: (manifest) => {
            const minecraft = versionIn(manifest.minecraftVersion);
            const version = versionIn(manifest.loaderVersion);
            if (!minecraft || !version) return null;
            return { minecraft, version, vars: { QUILT_LOADER_VERSION: version } };
        }
    }
];

function isMoving(value: string, moving: readonly string[]): boolean {
    return moving.includes(value.trim().toLowerCase());
}

/** The loader a server's `TYPE` names, when it is one this holds. */
export function loaderSpecOf(type: string | undefined | null): LoaderSpec | null {
    const wanted = (type ?? "").trim().toUpperCase();
    return LOADERS.find((spec) => spec.type === wanted) ?? null;
}

/** Every variable this module reads, so a caller can fetch them in one query. */
export const LOADER_ENV_KEYS: readonly string[] = [
    "TYPE",
    "VERSION",
    "FABRIC_LAUNCHER_VERSION",
    "FABRIC_INSTALLER_VERSION",
    ...new Set(LOADERS.flatMap((spec) => [spec.key, ...spec.legacyKeys, ...spec.custom]))
];

/** The path inside the container of the manifest for this loader. */
export function manifestPath(spec: LoaderSpec): string {
    return `/data/${spec.manifest}`;
}

/** The version a variable holds, as the image would read it: the main spelling,
 *  else the first legacy one that is set. */
function loaderValue(spec: LoaderSpec, env: EnvReader): string {
    const main = env(spec.key).trim();
    if (main.length > 0) return main;
    for (const key of spec.legacyKeys) {
        const legacy = env(key).trim();
        if (legacy.length > 0) return legacy;
    }
    return "";
}

/** A Minecraft release named exactly, rather than a channel the image resolves. */
export function isExactRelease(version: string): boolean {
    const value = version.trim().toUpperCase();
    return value.length > 0 && !["LATEST", "SNAPSHOT", "RELEASE"].includes(value);
}

/** Where a server's loader stands, as the settings screen shows it. */
export type LoaderPinState =
    /** Held at a version: a start asks nobody which one to run. */
    | { readonly state: "held"; readonly loader: string; readonly key: string; readonly version: string }
    /** Following the newest, and able to be held once the server has installed one. */
    | { readonly state: "following"; readonly loader: string; readonly key: string }
    /** Following the newest Minecraft too, so there is no one version to hold. */
    | { readonly state: "release"; readonly loader: string; readonly key: string }
    /** Runs an installer or a launcher of somebody's own. */
    | { readonly state: "custom"; readonly loader: string; readonly key: string }
    /** Not a mod loader this holds. */
    | { readonly state: "none" };

export function loaderPinState(env: EnvReader): LoaderPinState {
    const spec = loaderSpecOf(env("TYPE"));
    if (!spec) return { state: "none" };
    const base = { loader: spec.name, key: spec.key };
    if (spec.custom.some((key) => env(key).trim().length > 0)) return { state: "custom", ...base };
    const value = loaderValue(spec, env);
    if (!isMoving(value, spec.moving)) return { state: "held", ...base, version: value };
    if (!isExactRelease(env("VERSION"))) return { state: "release", ...base };
    return { state: "following", ...base };
}

/** The loader this server can be held at, when it is following the newest one
 *  and nothing else stands in the way. Null when there is nothing to pin. */
export function loaderToPin(env: EnvReader): LoaderSpec | null {
    return loaderPinState(env).state === "following" ? loaderSpecOf(env("TYPE")) : null;
}

/**
 * The variables that hold this server at what its manifest says is installed.
 *
 * Null unless the manifest is the helper's, parses, and was written for the very
 * release the server is set to: a manifest for another release is a server
 * part-way through moving to this one, and holding it at the old loader would
 * install that loader for the wrong game.
 */
export function pinFromManifest(
    env: EnvReader,
    manifestText: string
): { readonly loader: string; readonly version: string; readonly vars: Readonly<Record<string, string>> } | null {
    const spec = loaderToPin(env);
    return spec ? readManifest(spec, env, manifestText) : null;
}

/**
 * The loader version a manifest says is installed for the server's release,
 * whatever the server is set to run. What tells a held version that is on disk
 * from one a start would still have to download.
 */
export function installedFromManifest(env: EnvReader, manifestText: string): string | null {
    const spec = loaderSpecOf(env("TYPE"));
    return spec ? (readManifest(spec, env, manifestText)?.version ?? null) : null;
}

function readManifest(
    spec: LoaderSpec,
    env: EnvReader,
    manifestText: string
): { readonly loader: string; readonly version: string; readonly vars: Readonly<Record<string, string>> } | null {
    let parsed: unknown;
    try {
        parsed = JSON.parse(manifestText);
    } catch {
        return null;
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    const pin = spec.read(parsed as Record<string, unknown>, env);
    if (!pin || pin.minecraft !== env("VERSION").trim()) return null;
    return { loader: spec.name, version: pin.version, vars: pin.vars };
}

/** The variables to clear so the next start installs the newest loader once. */
export function unpinVars(env: EnvReader): string[] {
    const spec = loaderSpecOf(env("TYPE"));
    if (!spec) return [];
    const keys = [spec.key, ...spec.legacyKeys];
    // The installer was only ever held alongside the loader.
    if (spec.type === "FABRIC") keys.push("FABRIC_LAUNCHER_VERSION");
    return keys.filter((key) => env(key).trim().length > 0);
}

/**
 * The loader variables a change of software or release has to clear.
 *
 * A held loader version belongs to the release it was installed for: NeoForge
 * 21.4.158 is a 1.21.4 loader, and a server moved to 1.21.5 still holding it
 * asks for a build that does not exist and never starts. So a change that moves
 * the release, or the software, lets the held version go and the new release
 * resolves its own - which the sweep then holds again. A change that sets the
 * loader version itself is somebody choosing it, and is left alone.
 */
export function loaderReleasedBy(current: EnvReader, next: EnvReader): string[] {
    const spec = loaderSpecOf(next("TYPE"));
    if (!spec) return [];
    const releaseMoved = current("VERSION").trim() !== next("VERSION").trim();
    const softwareMoved = current("TYPE").trim().toUpperCase() !== next("TYPE").trim().toUpperCase();
    if (!releaseMoved && !softwareMoved) return [];
    const held = loaderValue(spec, next);
    if (held !== loaderValue(spec, current) || isMoving(held, spec.moving)) return [];
    return unpinVars(next);
}

/** An env reader over a plain record. */
export function envReader(env: Readonly<Record<string, string | undefined>>): EnvReader {
    return (key) => env[key] ?? "";
}
