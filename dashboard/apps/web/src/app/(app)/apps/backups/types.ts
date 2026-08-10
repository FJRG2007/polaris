/**
 * The shapes the console's routes answer with.
 *
 * Declared here rather than imported from the service, because the client
 * bundles these and the service reaches Prisma, storage drivers and container
 * ports - importing its types would drag its module graph into the browser.
 */

export interface ResourceRow {
    id: string;
    kind: string;
    kindLabel: string;
    name: string;
    status: string;
    planId: string | null;
    planName: string | null;
    lastBackupAt: string | null;
    lastStatus: string | null;
    lastError: string | null;
    nextDueAt: string | null;
    copyCount: number;
    sizeBytes: number;
    destinations: string[];
    canRestore: boolean;
}

export interface PlanSummary {
    id: string;
    name: string;
    every: string;
    keepLast: number;
    keepDays: number;
    maxBytes: number;
    notifyOnFailure: boolean;
    destinationIds: string[];
    destinationNames: string[];
    usedBy: number;
}

export interface DestinationSummary {
    id: string;
    name: string;
    kind: string;
    basePath: string;
    isDefault: boolean;
    status: string;
    lastError: string | null;
    lastCheckedAt: string | null;
    /** The connection or server behind it, when there is one. */
    via: string | null;
    viaKind: string | null;
    copyCount: number;
    usedByPlans: number;
    storedBytes: number;
}

export interface BackupOverview {
    summary: {
        protectedCount: number;
        copyCount: number;
        storedBytes: number;
        failedRecently: number;
        destinationsDown: number;
    };
    plans: PlanSummary[];
    destinations: DestinationSummary[];
}

export interface CopyRow {
    id: string;
    destinationId: string;
    destinationName: string;
    status: string;
    error: string | null;
    sizeBytes: number;
    downloadable: boolean;
}

export interface PointRow {
    id: string;
    takenAt: string;
    expiresAt: string | null;
    status: string;
    sizeBytes: number;
    error: string | null;
    copies: CopyRow[];
}

export interface JobRow {
    id: string;
    type: string;
    trigger: string;
    status: string;
    startedAt: string;
    finishedAt: string | null;
    error: string | null;
    resourceId?: string | null;
    resourceName?: string | null;
    bytes?: number;
}

export interface ResourceDetail {
    resource: ResourceRow;
    points: PointRow[];
    jobs: JobRow[];
}

export interface DiscoveredCandidate {
    kind: string;
    kindLabel: string;
    summary: string;
    selector: string;
    name: string;
    context?: string;
    target: Record<string, unknown>;
}
