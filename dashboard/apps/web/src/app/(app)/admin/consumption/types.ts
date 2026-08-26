/** Client-safe shapes for the Consumption screen. */

/** The five things a container on this machine can belong to. */
export type ConsumptionGroupId = "polaris" | "apps" | "services" | "leftover" | "other";

/** One thing that is using the machine: an installed app, a deployed service, a
 *  database, or a container nothing here claims. Several containers add up into
 *  one row - a service's kept releases and the tunnel publishing it are what that
 *  service costs. */
export interface ConsumptionRow {
    readonly id: string;
    readonly name: string;
    /** One line under the name: what kind of thing it is, or its image. */
    readonly detail: string;
    /** Whose it is, for the shelf it sits on. Null for a container nothing here
     *  owns. */
    readonly owner: string | null;
    readonly state: "running" | "restarting" | "partial" | "stopped" | "elsewhere";
    readonly stateLabel: string;
    /** How many containers were added up into this row. */
    readonly containers: number;
    /** Null until something has been sampled: a row that has just appeared has no
     *  figure yet, and a zero would read as one. */
    readonly cpuPercent: number | null;
    readonly memUsedBytes: number | null;
    /** Where opening the row goes, when the reader may go there. */
    readonly href: string | null;
    /**
     * What this row owns, each with its own figures: the servers made with the
     * Game servers app, the workers Places runs. Empty for everything that owns
     * nothing.
     *
     * They are inside the row rather than beside it because nobody installed six
     * Minecraft servers - they installed one app. Their figures are already part
     * of the row's total; this is the same total broken down, for the next
     * question, which is which of the six.
     */
    readonly parts: readonly ConsumptionRow[];
}

/** One group of rows and what the group costs between them. */
export interface ConsumptionGroup {
    readonly id: ConsumptionGroupId;
    readonly label: string;
    readonly description: string;
    /** Empty for Polaris itself, whose parts are measured separately (see
     *  `/api/polaris/footprint`) because its disk costs an order of magnitude
     *  more to read. The totals here are what the split above the page needs. */
    readonly rows: readonly ConsumptionRow[];
    readonly containers: number;
    /** How many of those containers are up, so a group can say what is running
     *  without adding its rows up. */
    readonly running: number;
    readonly cpuPercent: number;
    readonly memUsedBytes: number;
}

/** What the machine Polaris runs on is being spent on, as
 *  /api/admin/consumption answers. */
export interface Consumption {
    readonly machine: {
        readonly name: string;
        readonly ncpu: number;
        /** Null when the engine did not answer with one. */
        readonly memTotalBytes: number | null;
    };
    readonly groups: readonly ConsumptionGroup[];
    /** When the oldest of the readings was taken, so the screen can say how old
     *  the figures are. Null while nothing has been sampled yet. */
    readonly sampledAt: number | null;
    readonly at: string;
}

/** Memory the groups hold between them. What is left of the machine is the rest,
 *  and is not all free - the host itself is outside every container here. */
export function consumedMemBytes(consumption: Consumption): number {
    return consumption.groups.reduce((total, group) => total + group.memUsedBytes, 0);
}
