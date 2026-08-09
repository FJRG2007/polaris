/**
 * What Polaris can protect, and what each kind can be asked to do.
 *
 * One list rather than a check scattered across the screens: whether a kind can
 * be restored in place, whether its copies can live somewhere other than beside
 * it, and what to call it are all questions the console asks per row, and an
 * answer that lives in three places is one that will disagree with itself.
 *
 * Pure data and pure functions - no database, no drivers - so the client can
 * import it for labels without pulling the engine in behind it.
 */

/** Every kind of thing that can be backed up. */
export const RESOURCE_KINDS = [
    "polaris-database",
    "managed-database",
    "minecraft-world",
    "deploy-volume",
    "nas-path"
] as const;

export type ResourceKind = (typeof RESOURCE_KINDS)[number];

export interface ResourceKindInfo {
    readonly kind: ResourceKind;
    /** What it is called in a table cell. */
    readonly label: string;
    /** One line for the "protect something" list, in the second person. */
    readonly summary: string;
    /**
     * Whether a copy can be put back where it came from.
     *
     * False for a NAS path today: putting one back means writing over whatever
     * is there now, and a folder somebody has since reorganised is not a thing
     * to overwrite because a schedule said so. Download and restore by hand.
     */
    readonly canRestore: boolean;
    /**
     * Whether the source can hold a copy beside itself.
     *
     * True only for a game world, whose container can archive its own disk in
     * seconds. Everything else has to be read out before it is anywhere.
     */
    readonly supportsSourceLocal: boolean;
    /** Whether Polaris can find these on its own, or somebody has to describe one. */
    readonly discoverable: boolean;
}

export const RESOURCE_KINDS_INFO: Readonly<Record<ResourceKind, ResourceKindInfo>> = {
    "polaris-database": {
        kind: "polaris-database",
        label: "Polaris database",
        summary: "Everything Polaris itself knows: accounts, apps, settings, history.",
        // Deliberately not restorable from here. Polaris is running on this
        // database: rewriting it underneath the request doing the rewriting
        // invalidates the session that asked, the rows being read to authorize
        // it, and anything else mid-write. Restoring it is an operator putting
        // the download back with Polaris stopped, and pretending otherwise with
        // a button would be the most dangerous thing on the screen.
        canRestore: false,
        supportsSourceLocal: false,
        discoverable: true
    },
    "managed-database": {
        kind: "managed-database",
        label: "Database",
        summary: "A database Polaris runs for one of your services.",
        canRestore: true,
        supportsSourceLocal: false,
        discoverable: true
    },
    "minecraft-world": {
        kind: "minecraft-world",
        label: "Game world",
        summary: "A Minecraft world, archived with saving paused so it is not caught mid-write.",
        canRestore: true,
        supportsSourceLocal: true,
        discoverable: true
    },
    "deploy-volume": {
        kind: "deploy-volume",
        label: "Service data",
        summary: "A volume one of your services keeps its data in.",
        canRestore: true,
        supportsSourceLocal: false,
        discoverable: true
    },
    "nas-path": {
        kind: "nas-path",
        label: "Files",
        summary: "A folder on a storage connection.",
        canRestore: false,
        supportsSourceLocal: false,
        discoverable: false
    }
};

export function isResourceKind(value: unknown): value is ResourceKind {
    return typeof value === "string" && (RESOURCE_KINDS as readonly string[]).includes(value);
}

/** What to call a kind on screen, or the raw value when it is one we removed. */
export function resourceKindLabel(kind: string): string {
    return isResourceKind(kind) ? RESOURCE_KINDS_INFO[kind].label : kind;
}

/** Where copies can be written. */
export const DESTINATION_KINDS = ["local", "source-local", "connection", "host"] as const;

export type DestinationKind = (typeof DESTINATION_KINDS)[number];

export function isDestinationKind(value: unknown): value is DestinationKind {
    return typeof value === "string" && (DESTINATION_KINDS as readonly string[]).includes(value);
}

/** The name the seeded local destination is created under. */
export const DEFAULT_LOCAL_DESTINATION = "Polaris data dir";

/** The name the seeded beside-the-source destination is created under. */
export const DEFAULT_SOURCE_LOCAL_DESTINATION = "Beside the source";
