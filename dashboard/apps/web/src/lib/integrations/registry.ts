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

/** Dymo's non-secret config, with enforced defaults. */
export interface DymoConfig {
    /** Verify the visitor's IP on share-link and drop-point access. On by default. */
    verifyAccessIp: boolean;
    /** Dymo IP conditions that deny access (NegativeIPRules), e.g. FRAUD, PROXY, VPN. */
    deny: string[];
}

/** The IP rules an operator can toggle. Some are Dymo premium features. */
export const DYMO_IP_RULES: ReadonlyArray<{ value: string; label: string; premium?: boolean }> = [
    { value: "FRAUD", label: "Fraudulent / malicious" },
    { value: "PROXY", label: "Proxy" },
    { value: "VPN", label: "VPN" },
    { value: "TOR_NETWORK", label: "Tor exit node", premium: true },
    { value: "HIGH_RISK_SCORE", label: "High risk score", premium: true }
];

export const DYMO_DEFAULTS: DymoConfig = { verifyAccessIp: true, deny: ["FRAUD"] };

/** Read a stored Dymo config, keeping only known rules and applying defaults. */
export function readDymoConfig(config: Record<string, unknown> | undefined): DymoConfig {
    const valid = new Set(DYMO_IP_RULES.map((rule) => rule.value));
    const raw = Array.isArray(config?.deny) ? (config?.deny as unknown[]) : [];
    const deny = raw.filter((value): value is string => typeof value === "string" && valid.has(value));
    return {
        verifyAccessIp: config?.verifyAccessIp !== false,
        deny: deny.length > 0 ? deny : DYMO_DEFAULTS.deny
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
    },
    {
        slug: "dymo",
        name: "Dymo API",
        category: "Security",
        summary: "Verify a visitor's IP and block fraud, proxies and VPNs.",
        description:
            "When someone opens a share link or a drop point, Polaris checks their IP with the Dymo API and blocks access if it matches the conditions you choose (fraudulent, proxy, VPN, ...). Fails open on an API error so a hiccup never locks out your visitors.",
        docsUrl: "https://docs.tpeoficial.com/docs/dymo-api/private/ip-validation",
        requiresApiKey: true,
        apiKeyLabel: "API key",
        apiKeyHelp: "Get one at https://tpe.li/new-api-key."
    },
    {
        slug: "github",
        name: "GitHub",
        category: "Automation",
        summary: "Deploy from your repositories, including private ones.",
        description:
            "Connect a GitHub account so Deploy can list your repositories and build private ones. Today this uses a Personal Access Token; a one-click GitHub App is on the way.",
        docsUrl: "https://github.com/settings/tokens",
        requiresApiKey: true,
        apiKeyLabel: "Personal Access Token",
        apiKeyHelp:
            "A fine-grained token with Contents: Read on the repositories you want to deploy (or a classic token with the 'repo' scope)."
    },
    {
        slug: "cloudflare",
        name: "Cloudflare Tunnel",
        category: "Automation",
        summary: "Expose deployed apps over a public domain with no port-forwarding.",
        description:
            "Runs a Cloudflare Tunnel from this server so apps are reachable on your domain without opening any ports. Create a tunnel in the Cloudflare dashboard, add a public hostname pointing to http://<this-host-ip>:80, and paste its token here - Polaris routes each hostname to the right app.",
        docsUrl: "https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/",
        requiresApiKey: true,
        apiKeyLabel: "Tunnel token",
        apiKeyHelp: "The token shown when you create a tunnel (Zero Trust -> Networks -> Tunnels -> Install connector)."
    },
    {
        slug: "ngrok",
        name: "ngrok",
        category: "Automation",
        summary: "Expose deployed apps through an ngrok tunnel, no port-forwarding.",
        description:
            "Runs an ngrok agent from this server that forwards inbound traffic to Polaris. Good for quick public access; a reserved domain (ngrok paid) is recommended for a stable URL.",
        docsUrl: "https://dashboard.ngrok.com/get-started/your-authtoken",
        requiresApiKey: true,
        apiKeyLabel: "Authtoken",
        apiKeyHelp: "Your ngrok authtoken from the ngrok dashboard."
    }
];

/** Look up a catalog entry by slug. */
export function findIntegration(slug: string): IntegrationCatalogEntry | undefined {
    return INTEGRATIONS.find((entry) => entry.slug === slug);
}
