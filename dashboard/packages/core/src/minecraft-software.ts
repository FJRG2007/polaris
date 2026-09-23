/**
 * The server software a Minecraft server can run, in one place.
 *
 * Three screens ask the same question and used to answer it with three different
 * lists: the create dialog, the settings field on the app manifest, and whatever
 * `TYPE` a server was installed with months ago. A list per screen is how an
 * option ends up creatable but unnameable - a server running Purpur that the
 * table calls "Purpur" and the settings picker cannot select, because that
 * spelling is not on its list.
 *
 * Every entry here is a `TYPE` the image actually dispatches on. That list is not
 * a guess: it is the case block in the image's own `start-configuration`, which
 * exits with "Invalid TYPE" for anything else - so a name that looks right and is
 * not on it is a server that never starts, and the reason scrolls past in a log
 * nobody reads. The ones the image supports but this list leaves out are the ones
 * that need a value nobody can be asked for: Magma needs a Forge version and a
 * release tag of its own, and Crucible and Canyon each run one ancient release.
 * Anything else somebody wants is `CUSTOM` with the URL of its jar, which is the
 * honest way to offer software this repo has never seen.
 *
 * Pure data, in core, because both sides of the app boundary read it: the
 * manifest in the dashboard and the panel in Game servers.
 */

/** The shelves the picker groups by, in the order it shows them. */
export const SOFTWARE_GROUPS = [
    { id: "recommended", label: "Recommended" },
    { id: "established", label: "Established" },
    { id: "experimental", label: "Experimental" },
    { id: "hybrid", label: "Plugins and mods together" },
    { id: "lobby", label: "Lobby servers" },
    { id: "modpack", label: "Modpacks" },
    { id: "other", label: "Anything else" }
] as const;

export type SoftwareGroup = (typeof SOFTWARE_GROUPS)[number]["id"];

/**
 * What a server runs, and everything that follows from it.
 *
 * `loader` is what Modrinth files projects under, and null means nothing there
 * loads into this: a browser opened against it would answer with an empty shelf
 * that looks like an outage. `weight` is what the software costs before anything
 * at all is installed on it, which is what the memory plan is built from - a mod
 * loader is about a gigabyte and a plugin server is a quarter of one.
 */
export interface MinecraftSoftware {
    /** The `TYPE` the image dispatches on. Shouted, because the image compares it
     *  upper-cased and every stored server already holds it that way. */
    readonly id: string;
    readonly name: string;
    readonly summary: string;
    readonly group: SoftwareGroup;
    readonly loader: string | null;
    readonly weight: "vanilla" | "plugins" | "mods";
    /** What else the image needs set for this one to install at all. Written with
     *  the server rather than asked for: none of it is a decision anybody can make
     *  from what is on screen. */
    readonly env?: Readonly<Record<string, string>>;
    /** A value only the operator has: the jar for `CUSTOM`, the pack for a
     *  modpack. The dialog asks for it and refuses without it. */
    readonly asks?: "jar" | "modpack";
    /** Said on the card, when choosing this commits to something somebody would
     *  otherwise find out from a log. */
    readonly caveat?: string;
}

export const MINECRAFT_SOFTWARE: readonly MinecraftSoftware[] = [
    {
        id: "PAPER",
        name: "Paper",
        summary: "Runs Bukkit and Spigot plugins, and is considerably faster than vanilla.",
        group: "recommended",
        loader: "paper",
        weight: "plugins"
    },
    {
        id: "VANILLA",
        name: "Vanilla",
        summary: "The server Mojang ships, exactly as they ship it. Nothing loads into it.",
        group: "recommended",
        loader: null,
        weight: "vanilla"
    },
    {
        id: "FABRIC",
        name: "Fabric",
        summary: "A light mod loader. Mods have to be built for it and for the release.",
        group: "recommended",
        loader: "fabric",
        weight: "mods"
    },
    {
        id: "NEOFORGE",
        name: "NeoForge",
        summary: "The mod loader most modern modpacks are built on.",
        group: "recommended",
        loader: "neoforge",
        weight: "mods"
    },
    {
        id: "FORGE",
        name: "Forge",
        summary: "The original mod loader, and what older mods target.",
        group: "recommended",
        loader: "forge",
        weight: "mods"
    },
    {
        id: "PURPUR",
        name: "Purpur",
        summary: "Paper with several hundred more settings and some gameplay of its own.",
        group: "recommended",
        loader: "paper",
        weight: "plugins"
    },
    {
        id: "PUFFERFISH",
        name: "Pufferfish",
        summary: "A Paper fork tuned for servers with a lot of people on them.",
        group: "established",
        loader: "paper",
        weight: "plugins"
    },
    {
        id: "LEAF",
        name: "Leaf",
        summary: "A Paper fork that trades a little vanilla behaviour for speed.",
        group: "established",
        loader: "paper",
        weight: "plugins"
    },
    {
        id: "FOLIA",
        name: "Folia",
        summary: "Paper that ticks regions of the world in parallel.",
        group: "established",
        loader: "folia",
        weight: "plugins",
        caveat: "Only plugins built for Folia load. An ordinary Paper plugin will not."
    },
    {
        id: "SPIGOT",
        name: "Spigot",
        summary: "The server Paper is a fork of. Paper runs the same plugins and is faster.",
        group: "established",
        loader: "spigot",
        weight: "plugins",
        // Spigot's downloads stopped answering automated requests, so the image's
        // only remaining way to get one is to compile it. That is minutes of the
        // first start with nothing on screen but a log, which is worth saying
        // before somebody picks it rather than after.
        env: { BUILD_FROM_SOURCE: "true" },
        caveat: "Built from source the first time it starts, which takes several minutes."
    },
    {
        id: "SPONGEVANILLA",
        name: "SpongeVanilla",
        summary: "The Sponge platform on the vanilla server, for plugins written against its API.",
        group: "established",
        loader: null,
        weight: "plugins",
        caveat: "Sponge plugins are not on Modrinth, so they go into the server files by hand."
    },
    {
        id: "QUILT",
        name: "Quilt",
        summary: "A fork of Fabric. It loads most Fabric mods as well as its own.",
        group: "experimental",
        loader: "quilt",
        weight: "mods"
    },
    {
        id: "ARCLIGHT",
        name: "Arclight",
        summary: "NeoForge with the Bukkit API on top, so mods and plugins run side by side.",
        group: "hybrid",
        loader: "bukkit",
        weight: "mods"
    },
    {
        id: "MOHIST",
        name: "Mohist",
        summary: "Forge with the Bukkit API on top.",
        group: "hybrid",
        loader: "bukkit",
        weight: "mods"
    },
    {
        id: "YOUER",
        name: "Youer",
        summary: "NeoForge with the Bukkit API on top, from the people who make Mohist.",
        group: "hybrid",
        loader: "bukkit",
        weight: "mods"
    },
    {
        id: "BANNER",
        name: "Banner",
        summary: "Fabric with the Bukkit API on top.",
        group: "hybrid",
        loader: "bukkit",
        weight: "mods"
    },
    {
        id: "KETTING",
        name: "Ketting",
        summary: "Forge and Bukkit together, for Minecraft 1.20.1 and later.",
        group: "hybrid",
        loader: "bukkit",
        weight: "mods",
        caveat: "Nothing before Minecraft 1.20.1 has a build."
    },
    {
        id: "LIMBO",
        name: "Limbo",
        summary: "An empty holding server: no world and no gameplay, somewhere to put people.",
        group: "lobby",
        loader: null,
        weight: "vanilla",
        caveat: "It ignores the release you pick and runs whatever its own build targets."
    },
    {
        id: "NANOLIMBO",
        name: "NanoLimbo",
        summary: "The same idea as Limbo in as little memory as it can be done in.",
        group: "lobby",
        loader: null,
        weight: "vanilla"
    },
    {
        id: "MODRINTH",
        name: "Modrinth modpack",
        summary: "A modpack from Modrinth. It brings its own mod loader and its own mods.",
        group: "modpack",
        loader: null,
        weight: "mods",
        asks: "modpack"
    },
    {
        id: "CUSTOM",
        name: "Custom server jar",
        summary: "Any other server: give the URL of its jar and the container runs that.",
        group: "other",
        loader: null,
        weight: "vanilla",
        asks: "jar",
        caveat: "Polaris cannot update it or say what it supports - that part stays yours."
    }
];

/** One entry by its `TYPE`, however it was spelled. Null for a server carrying
 *  something this list has never heard of, which is a thing to report rather than
 *  to correct: it may well be running. */
export function findSoftware(type: string | undefined | null): MinecraftSoftware | null {
    const wanted = (type ?? "").trim().toUpperCase();
    if (wanted.length === 0) return null;
    return MINECRAFT_SOFTWARE.find((entry) => entry.id === wanted) ?? null;
}

/** Whether this is a `TYPE` a server can be created with here. */
export function isServerSoftware(type: string): boolean {
    return findSoftware(type) !== null;
}

/** `PAPER` as a person writes it, and the raw value for anything not on the list
 *  so a server that predates it is still nameable. */
export function softwareLabel(type: string | undefined | null): string {
    const known = findSoftware(type);
    if (known) return known.name;
    const raw = (type ?? "").trim();
    if (raw.length === 0) return "Vanilla";
    return raw.charAt(0).toUpperCase() + raw.slice(1).toLowerCase();
}

/** What Modrinth files projects for this software under, or null when nothing
 *  there loads into it. */
export function modrinthLoaderOf(type: string | undefined | null): string | null {
    return findSoftware(type)?.loader ?? null;
}

/**
 * Every loader something in this catalogue is filed under on Modrinth.
 *
 * What a mods browser may be asked for, derived rather than written out: a list
 * of loaders kept by hand beside a list of software is a server that can be
 * created and whose mods screen then refuses to open.
 */
export function modrinthLoaders(): string[] {
    return [
        ...new Set(
            MINECRAFT_SOFTWARE.map((entry) => entry.loader).filter(
                (loader): loader is string => loader !== null
            )
        )
    ].sort();
}

/** Whether a mods browser can be opened against this loader at all. */
export function isBrowsableLoader(loader: string): boolean {
    return modrinthLoaders().includes(loader);
}

/** The software in the order the picker shows it, by group. */
export function softwareByGroup(): { group: SoftwareGroup; label: string; entries: MinecraftSoftware[] }[] {
    return SOFTWARE_GROUPS.map((group) => ({
        group: group.id,
        label: group.label,
        entries: MINECRAFT_SOFTWARE.filter((entry) => entry.group === group.id)
    })).filter((shelf) => shelf.entries.length > 0);
}

/**
 * Whether this names a Modrinth modpack the image could resolve.
 *
 * Either the short name out of the pack's own address, or a link to the pack or
 * to one of its versions. Deliberately not a guess at Modrinth's id alphabet: the
 * image hands whatever this is to Modrinth and reports what comes back, and the
 * job here is to catch the empty box and the pasted paragraph.
 */
export function isModpackReference(value: string): boolean {
    const wanted = value.trim();
    if (wanted.length === 0 || wanted.length > 200) return false;
    if (/^https:\/\/[\w.-]+\//.test(wanted)) return true;
    return /^[A-Za-z0-9][A-Za-z0-9!@$()+,._'"-]{0,63}$/.test(wanted);
}

/** Whether this is a link to a server jar the container can fetch. Https only:
 *  the file becomes the server, and http is a file anybody on the way can
 *  replace. */
export function isServerJarUrl(value: string): boolean {
    const wanted = value.trim();
    if (wanted.length === 0 || wanted.length > 500) return false;
    if (!/^https:\/\//i.test(wanted)) return false;
    try {
        return new URL(wanted).pathname.toLowerCase().endsWith(".jar");
    } catch {
        return false;
    }
}

/** What the image needs told when this software takes a value of its own, or an
 *  empty object for the software that takes none. */
export function softwareSourceEnv(type: string, source: string): Record<string, string> {
    const known = findSoftware(type);
    const value = source.trim();
    if (!known?.asks || value.length === 0) return {};
    return known.asks === "modpack" ? { MODRINTH_MODPACK: value } : { CUSTOM_SERVER: value };
}

/** The entries whose name or description answers to what somebody typed. An empty
 *  search is everything, which is what an untouched search box means. */
export function searchSoftware(query: string): MinecraftSoftware[] {
    const wanted = query.trim().toLowerCase();
    if (wanted.length === 0) return [...MINECRAFT_SOFTWARE];
    return MINECRAFT_SOFTWARE.filter(
        (entry) =>
            entry.name.toLowerCase().includes(wanted) ||
            entry.id.toLowerCase().includes(wanted) ||
            entry.summary.toLowerCase().includes(wanted)
    );
}
