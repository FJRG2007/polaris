/**
 * The integrations marketplace catalog: the fixed set of integrations Polaris
 * knows how to run. This is code, not data - each entry describes how it is
 * configured and what it does, and a matching Integration row records whether an
 * operator has enabled it. New integrations are added here.
 */

export type IntegrationCategory =
    | "Security"
    | "Notifications"
    | "Storage"
    | "Automation"
    | "Productivity"
    | "Models";

/**
 * A page on the vendor's own site that produces what the dialog is asking for.
 *
 * The point is to land the operator where the only thing left is to press the
 * vendor's own button, so the URL carries whatever that vendor lets it carry.
 * Most of them carry nothing, which is why the dialog still shows the values to
 * paste; Cloudflare pre-ticks its permissions and GitHub creates the whole app.
 */
export interface IntegrationSetupLink {
    /** What pressing it does, in the imperative. */
    label: string;
    url: string;
    /** One line, when the step needs a word about why it exists. */
    help?: string;
}

export interface IntegrationCatalogEntry {
    /** Stable slug; the Integration row's provider and the marketplace key. */
    slug: string;
    name: string;
    category: IntegrationCategory;
    /** One-line marketplace summary. */
    summary: string;
    /** A short paragraph shown on the configure screen. */
    description: string;
    /** Vendor docs. */
    docsUrl: string;
    /** Where the credential is actually created, in the order the steps happen.
     *  Empty for an integration whose dialog creates it (GitHub) or builds the
     *  link itself from what the operator picked (Cloudflare). */
    setupLinks?: readonly IntegrationSetupLink[];
    /** Whether this integration authenticates with an API key. */
    requiresApiKey: boolean;
    apiKeyLabel?: string;
    apiKeyHelp?: string;
    /** Models only: what a repository runs on when this is the provider picked.
     *  One sensible default each, so connecting a key is the whole setup - the
     *  field still accepts any specifier the runtime understands. */
    defaultModel?: { label: string; slug: string };
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

/**
 * The gateway's non-secret settings.
 *
 * An OpenAI-compatible endpoint brings no catalog with it, so everything a
 * provider would normally publish has to be stated here: which model to ask for
 * and how much it can hold. The two limits are not optional - a run that does
 * not know them caps its answers at 32000 tokens and turns compaction off for
 * the whole run, which reads as the agent giving up halfway.
 */
export interface GatewayConfig {
    /** The endpoint's OpenAI-compatible base URL, e.g. https://host/v1. */
    baseUrl: string;
    /** The model id the endpoint serves. */
    model: string;
    /** Context window, in tokens. */
    context: number;
    /** Largest answer, in tokens. */
    maxOutput: number;
}

/** Read a stored gateway config. Missing numbers come back as 0, which is what
 *  the dialog and the save action both treat as "not set yet". */
export function readGatewayConfig(config: Record<string, unknown> | undefined): GatewayConfig {
    const text = (value: unknown): string => (typeof value === "string" ? value : "");
    const count = (value: unknown): number => (typeof value === "number" && value > 0 ? Math.floor(value) : 0);
    return {
        baseUrl: text(config?.baseUrl),
        model: text(config?.model),
        context: count(config?.context),
        maxOutput: count(config?.maxOutput)
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
        setupLinks: [{ label: "Get your API key", url: "https://www.virustotal.com/gui/my-apikey" }],
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
        setupLinks: [{ label: "Create an API key", url: "https://tpe.li/new-api-key" }],
        requiresApiKey: true,
        apiKeyLabel: "API key"
    },
    {
        slug: "criminalip",
        name: "Criminal IP",
        category: "Security",
        summary: "Block addresses already known for scanning or attacks.",
        description:
            "The firewall asks Criminal IP about addresses it sees in your traffic and blocks the ones that match the conditions you choose. Lookups happen in the background, never while a request is waiting, and the answer is cached - so a slow or unreachable provider can never slow down or open up your site.",
        docsUrl: "https://www.criminalip.io/developer/api/get-ip-summary",
        setupLinks: [{ label: "Get your API key", url: "https://www.criminalip.io/mypage/information" }],
        requiresApiKey: true,
        apiKeyLabel: "API key",
        apiKeyHelp: "It is on the My Information page, under API Key."
    },
    {
        slug: "github",
        name: "GitHub",
        category: "Automation",
        summary: "Let people connect their GitHub, sign in with it, and deploy their repositories.",
        description:
            "Create a GitHub App in one click and Polaris can build private repositories, register self-hosted runners, and give everyone here a Connect button for their own GitHub account. Each person then sees their own repositories and nobody else's, and can sign in with the account they linked if you allow it.",
        docsUrl: "https://docs.github.com/apps/creating-github-apps",
        requiresApiKey: true,
        apiKeyLabel: "Personal Access Token",
        apiKeyHelp:
            "A fine-grained token with Contents: Read on the repositories you want to deploy (or a classic token with the 'repo' scope)."
    },
    {
        slug: "google",
        name: "Google",
        category: "Automation",
        summary: "Let people connect their Google account, sign in with it, and show their calendar.",
        description:
            "Connect a Google Cloud OAuth client and everyone here gets a Connect button for their own Google account. Their events then appear in the Tasks calendar, read-only, and they can sign in with the account they linked if you allow it. Polaris never holds a credential that reaches everybody's calendar - only the access each person granted.",
        docsUrl: "https://developers.google.com/identity/protocols/oauth2",
        setupLinks: [
            {
                label: "Create an OAuth client",
                url: "https://console.cloud.google.com/auth/clients/create",
                help: "Application type: Web application. Google has no way to pre-fill the form, so paste the redirect URI below into it."
            },
            {
                label: "Enable the Calendar API",
                url: "https://console.cloud.google.com/apis/library/calendar-json.googleapis.com",
                help: "On the same project. Without it the client authorizes fine and every calendar comes back empty."
            }
        ],
        requiresApiKey: true,
        apiKeyLabel: "Client secret",
        apiKeyHelp: "Shown once when the client is created, and downloadable from the client afterwards."
    },
    {
        slug: "cloudflare",
        name: "Cloudflare",
        category: "Automation",
        summary: "Create your DNS records and expose apps with no port-forwarding.",
        description:
            "Connect an API token and Polaris writes your zones' DNS records and gives each app its own tunnel, so nothing is typed into a DNS panel and no ports are opened. One token can do both, or connect DNS and tunnels separately. A connector token can also be pasted here to run a single server-wide tunnel instead.",
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
        docsUrl: "https://ngrok.com/docs/agent/",
        setupLinks: [
            { label: "Get your authtoken", url: "https://dashboard.ngrok.com/get-started/your-authtoken" }
        ],
        requiresApiKey: true,
        apiKeyLabel: "Authtoken"
    },
    {
        slug: "duckdns",
        name: "DuckDNS",
        category: "Automation",
        summary: "Free dynamic DNS - keep a subdomain pointed at your changing IP.",
        description:
            "Points a free <name>.duckdns.org subdomain at this server's public IP and keeps it updated as your ISP address changes, so a home box stays reachable. DuckDNS also resolves *.<name>.duckdns.org, so it works as a wildcard base for app subdomains.",
        docsUrl: "https://www.duckdns.org/spec.jsp",
        setupLinks: [{ label: "Get your token", url: "https://www.duckdns.org/" }],
        requiresApiKey: true,
        apiKeyLabel: "Token",
        apiKeyHelp: "Shown at the top of the page once you sign in."
    },
    // Models. These are what the Agents app runs on: a key here is the operator's
    // own account with that provider, and Polaris adds nothing to the bill. A run
    // is handed every connected key rather than only the one its model needs, so
    // a model whose provider is not connected falls back instead of failing.
    {
        slug: "anthropic",
        name: "Anthropic",
        category: "Models",
        summary: "Run agents on Claude models.",
        description:
            "Connects your Anthropic account so agents can run on Claude. Polaris hands the key to a run over an authenticated call and never writes a copy into your repositories, so rotating it here takes effect everywhere at once. Usage is billed by Anthropic directly.",
        docsUrl: "https://docs.claude.com/en/api/overview",
        setupLinks: [{ label: "Create an API key", url: "https://console.anthropic.com/settings/keys" }],
        requiresApiKey: true,
        apiKeyLabel: "API key",
        apiKeyHelp: "Starts with sk-ant-. Needs no particular scope.",
        defaultModel: { label: "Claude (Anthropic)", slug: "anthropic/claude-opus" }
    },
    {
        slug: "openai",
        name: "OpenAI",
        category: "Models",
        summary: "Run agents on GPT models.",
        description:
            "Connects your OpenAI account so agents can run on GPT models. The key is held here and handed to a run over an authenticated call, never copied into your repositories. Usage is billed by OpenAI directly.",
        docsUrl: "https://platform.openai.com/docs/api-reference",
        setupLinks: [{ label: "Create an API key", url: "https://platform.openai.com/api-keys" }],
        requiresApiKey: true,
        apiKeyLabel: "API key",
        apiKeyHelp: "A project key works. Give it access to the models you want agents to use.",
        defaultModel: { label: "GPT (OpenAI)", slug: "openai/gpt-luna" }
    },
    {
        slug: "google-ai",
        name: "Google AI",
        category: "Models",
        summary: "Run agents on Gemini models.",
        description:
            "Connects Google AI Studio so agents can run on Gemini. The key is held here and handed to a run over an authenticated call, never copied into your repositories. Usage is billed by Google directly.",
        docsUrl: "https://ai.google.dev/gemini-api/docs",
        setupLinks: [{ label: "Create an API key", url: "https://aistudio.google.com/apikey" }],
        requiresApiKey: true,
        apiKeyLabel: "API key",
        apiKeyHelp: "From AI Studio, not a Google Cloud service account.",
        defaultModel: { label: "Gemini (Google)", slug: "google/gemini-3.1-flash-lite" }
    },
    {
        slug: "xai",
        name: "xAI",
        category: "Models",
        summary: "Run agents on Grok models.",
        description:
            "Connects your xAI account so agents can run on Grok. The key is held here and handed to a run over an authenticated call, never copied into your repositories. Usage is billed by xAI directly.",
        docsUrl: "https://docs.x.ai/",
        setupLinks: [{ label: "Create an API key", url: "https://console.x.ai/" }],
        requiresApiKey: true,
        apiKeyLabel: "API key",
        defaultModel: { label: "Grok (xAI)", slug: "xai/grok" }
    },
    {
        slug: "deepseek",
        name: "DeepSeek",
        category: "Models",
        summary: "Run agents on DeepSeek models.",
        description:
            "Connects your DeepSeek account so agents can run on its coding and reasoning models, which cost a fraction of the frontier ones. The key is held here and handed to a run over an authenticated call, never copied into your repositories.",
        docsUrl: "https://api-docs.deepseek.com/",
        setupLinks: [{ label: "Create an API key", url: "https://platform.deepseek.com/api_keys" }],
        requiresApiKey: true,
        apiKeyLabel: "API key",
        defaultModel: { label: "DeepSeek Pro", slug: "deepseek/deepseek-pro" }
    },
    {
        slug: "moonshot",
        name: "Moonshot AI",
        category: "Models",
        summary: "Run agents on Kimi models.",
        description:
            "Connects your Moonshot AI account so agents can run on Kimi. The key is held here and handed to a run over an authenticated call, never copied into your repositories. Usage is billed by Moonshot directly.",
        docsUrl: "https://platform.moonshot.ai/docs",
        setupLinks: [{ label: "Create an API key", url: "https://platform.moonshot.ai/console/api-keys" }],
        requiresApiKey: true,
        apiKeyLabel: "API key",
        defaultModel: { label: "Kimi K3 (Moonshot AI)", slug: "moonshotai/kimi-k3" }
    },
    {
        slug: "groq",
        name: "Groq",
        category: "Models",
        summary: "Open models, answered in a fraction of the time.",
        description:
            "Connects your Groq account so agents can run on the open models it serves (GPT OSS, Qwen, Llama) at speeds no other provider matches. Good for the runs where waiting costs more than the tokens do. Usage is billed by Groq directly.",
        docsUrl: "https://console.groq.com/docs/overview",
        setupLinks: [{ label: "Create an API key", url: "https://console.groq.com/keys" }],
        requiresApiKey: true,
        apiKeyLabel: "API key",
        defaultModel: { label: "GPT OSS 120B (Groq)", slug: "groq/openai/gpt-oss-120b" }
    },
    {
        slug: "cerebras",
        name: "Cerebras",
        category: "Models",
        summary: "Open models on wafer-scale hardware.",
        description:
            "Connects your Cerebras account so agents can run on the open models it serves (GLM, GPT OSS, Gemma). Like Groq, it trades the frontier models for speed. Usage is billed by Cerebras directly.",
        docsUrl: "https://inference-docs.cerebras.ai/",
        setupLinks: [{ label: "Create an API key", url: "https://cloud.cerebras.ai/platform/" }],
        requiresApiKey: true,
        apiKeyLabel: "API key",
        defaultModel: { label: "GLM 4.7 (Cerebras)", slug: "cerebras/zai-glm-4.7" }
    },
    {
        slug: "openrouter",
        name: "OpenRouter",
        category: "Models",
        summary: "One key for models from many providers.",
        description:
            "Routes agent runs through OpenRouter, which serves models from several providers behind one credential. Useful when you want a model Polaris has no direct integration for, or one key instead of several. Usage is billed by OpenRouter directly.",
        docsUrl: "https://openrouter.ai/docs",
        setupLinks: [{ label: "Create an API key", url: "https://openrouter.ai/settings/keys" }],
        requiresApiKey: true,
        apiKeyLabel: "API key",
        apiKeyHelp: "Starts with sk-or-. Set a spend limit on it if you want a ceiling.",
        defaultModel: { label: "MiniMax M2.5 (OpenRouter)", slug: "openrouter/minimax-m2.5" }
    },
    {
        slug: "enigma",
        name: "Enigma",
        category: "Models",
        summary: "Run agents through an OpenAI-compatible gateway.",
        description:
            "Points agent runs at an OpenAI-compatible endpoint instead of a provider key, so a run reuses whatever coding-agent subscription is already behind it rather than metering a second one. The endpoint has to be reachable from wherever runs happen: a loopback address works for runs on this box and not for runs on GitHub-hosted machines.",
        docsUrl: "https://github.com/FJRG2007/enigma",
        requiresApiKey: true,
        apiKeyLabel: "Token",
        apiKeyHelp: "Whatever the endpoint expects. Leave it blank if it accepts unauthenticated calls from this network.",
        defaultModel: { label: "Your gateway's model", slug: "openai-compatible/byok" }
    }
];

/** Look up a catalog entry by slug. */
export function findIntegration(slug: string): IntegrationCatalogEntry | undefined {
    return INTEGRATIONS.find((entry) => entry.slug === slug);
}

/** The model providers agents run on. Their own screen, because they are a
 *  different job from connecting a service and there are more of them than of
 *  everything else put together. */
export const MODEL_INTEGRATIONS = INTEGRATIONS.filter((entry) => entry.category === "Models");

/** The rest of the marketplace. */
export const SERVICE_INTEGRATIONS = INTEGRATIONS.filter((entry) => entry.category !== "Models");
