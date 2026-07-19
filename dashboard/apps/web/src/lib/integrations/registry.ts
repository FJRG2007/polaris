/**
 * The integrations marketplace catalog: the fixed set of integrations Polaris
 * knows how to run. This is code, not data - each entry describes how it is
 * configured and what it does, and a matching Integration row records whether an
 * operator has enabled it. New integrations are added here.
 */

export type IntegrationCategory = "Security" | "Notifications" | "Storage" | "Automation";

export interface IntegrationCatalogEntry {
    /** Stable slug; the Integration row's provider and the marketplace key. */
    slug: string;
    name: string;
    category: IntegrationCategory;
    /** One-line marketplace summary. */
    summary: string;
    /** A short paragraph shown on the configure screen. */
    description: string;
    /** Vendor docs / API key page. */
    docsUrl: string;
    /** Whether this integration authenticates with an API key. */
    requiresApiKey: boolean;
    apiKeyLabel?: string;
    apiKeyHelp?: string;
}

/** What to do when a scan integration flags an uploaded file. */
export type ScanAction = "block" | "quarantine" | "notify";

export const SCAN_ACTIONS: ReadonlyArray<{ value: ScanAction; label: string; help: string }> = [
    {
        value: "block",
        label: "Block the upload",
        help: "Reject the file and remove it. The uploader is told it was rejected."
    },
    {
        value: "quarantine",
        label: "Quarantine the file",
        help: "Keep the file but move it out of the destination into a quarantine folder."
    },
    { value: "notify", label: "Keep and notify only", help: "Store the file and just alert you." }
];

/** VirusTotal's non-secret config, with the enforced defaults. */
export interface VirusTotalConfig {
    /** Scan files uploaded to drop points. On by default once enabled. */
    scanDropPoints: boolean;
    /** What to do when a file is flagged. Defaults to blocking the upload. */
    onDetection: ScanAction;
}

export const VIRUSTOTAL_DEFAULTS: VirusTotalConfig = { scanDropPoints: true, onDetection: "block" };

/** Read a stored VirusTotal config object, applying defaults for missing keys. */
export function readVirusTotalConfig(config: Record<string, unknown> | undefined): VirusTotalConfig {
    const action = config?.onDetection;
    const onDetection: ScanAction =
        action === "quarantine" || action === "notify" || action === "block" ? action : VIRUSTOTAL_DEFAULTS.onDetection;
    return {
        scanDropPoints: config?.scanDropPoints !== false,
        onDetection
    };
}

export const INTEGRATIONS: readonly IntegrationCatalogEntry[] = [
    {
        slug: "virustotal",
        name: "VirusTotal",
        category: "Security",
        summary: "Scan uploaded files against 70+ antivirus engines.",
        description:
            "Automatically scans files uploaded to your drop points with the VirusTotal Public API and alerts you when something is flagged. Choose whether a detection blocks, quarantines, or just notifies.",
        docsUrl: "https://docs.virustotal.com/reference/overview",
        requiresApiKey: true,
        apiKeyLabel: "Public API key",
        apiKeyHelp: "Find it under your VirusTotal profile -> API key. The free Public API allows about 4 lookups per minute."
    }
];

/** Look up a catalog entry by slug. */
export function findIntegration(slug: string): IntegrationCatalogEntry | undefined {
    return INTEGRATIONS.find((entry) => entry.slug === slug);
}
