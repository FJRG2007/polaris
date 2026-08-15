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
 * Something this deployment knows that a vendor's form is asking for.
 *
 * None of these can be guessed from the other side: the redirect URI is decided
 * by the address Polaris answers on, and the three public pages are the ones a
 * review desk will open. Naming them per step is what puts each value beside the
 * form that wants it, instead of in one list at the bottom that an operator has
 * to match up by eye.
 */
export type IntegrationSetupValue = "redirectUri" | "homeUrl" | "privacyUrl" | "termsUrl" | "logoUrl" | "domain";

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
    /** What this step asks to be pasted in, shown beside it ready to copy. */
    values?: readonly IntegrationSetupValue[];
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
                label: "Fill in the consent screen",
                url: "https://console.cloud.google.com/auth/branding",
                help: "Google refuses to create a client until this exists. Audience: External, unless everybody here is in the same Workspace. Name the app exactly Polaris - verification compares it against the name on the home page - and give it these three URLs and the logo.",
                values: ["homeUrl", "privacyUrl", "termsUrl", "logoUrl"]
            },
            {
                label: "Add the authorized domain",
                url: "https://console.cloud.google.com/auth/branding",
                help: "Same page, under Authorized domains. Every URL above has to sit on it, and Google rejects an IP address outright - this needs a domain name.",
                values: ["domain"]
            },
            {
                label: "Prove you own the domain",
                url: "https://search.google.com/search-console",
                help: "Verification refuses a home page that is 'not registered to you'. Add the domain in Search Console, signed in as the account that owns this Cloud project, and complete the DNS check it gives you.",
                values: ["domain"]
            },
            {
                label: "Create an OAuth client",
                url: "https://console.cloud.google.com/auth/clients/create",
                help: "Application type: Web application. Google has no way to pre-fill the form, so paste this into Authorized redirect URIs.",
                values: ["redirectUri"]
            },
            {
                label: "Enable the Calendar API",
                url: "https://console.cloud.google.com/apis/library/calendar-json.googleapis.com",
                help: "On the same project. Without it the client authorizes fine and every calendar comes back empty."
            },
            {
                label: "Publish the app",
                url: "https://console.cloud.google.com/auth/audience",
                help: "A new client is in Testing, where only the accounts listed as test users may authorize and everybody else is refused with access_denied. Publishing lifts that. Until you are ready to, add each person as a test user instead."
            },
            {
                label: "Submit it for verification",
                url: "https://console.cloud.google.com/auth/verification",
                help: "The last step, and the only one that removes the 'Google hasn't verified this app' warning. Reading a calendar is a sensitive scope, so Google wants the pages above, the domain proved, a reason for the scope, and a video of somebody connecting an account. Published but unverified works - everyone just has to click through the warning first."
            }
        ],
        requiresApiKey: true,
        apiKeyLabel: "Client secret",
        apiKeyHelp: "Shown once when the client is created, and downloadable from the client afterwards."
    },
    {
        slug: "microsoft",
        name: "Microsoft",
        category: "Automation",
        summary: "Let people connect their Microsoft account and keep backups in their OneDrive.",
        description:
            "Register an Entra application and everyone here gets a Connect button for their own Microsoft account. Their OneDrive can then be chosen as a backup destination, and Polaris only ever touches the folder it creates there. Polaris holds no credential that reaches anybody's files - only the access each person granted.",
        docsUrl: "https://learn.microsoft.com/entra/identity-platform/quickstart-register-app",
        setupLinks: [
            {
                label: "Register an application",
                url: "https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/CreateApplicationBlade",
                help: "Supported account types: any organizational directory and personal Microsoft accounts. Paste the redirect URI below into the Web platform."
            },
            {
                label: "Add the Files.ReadWrite permission",
                url: "https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade",
                help: "Delegated, on the same application. Without it the account links fine and every upload is refused."
            }
        ],
        requiresApiKey: true,
        apiKeyLabel: "Client secret",
        apiKeyHelp: "The secret's value, not its id. Shown once when it is created."
    },
    {
        slug: "dropbox",
        name: "Dropbox",
        category: "Automation",
        summary: "Let people connect their Dropbox and keep backups in it.",
        description:
            "Create a Dropbox app and everyone here gets a Connect button for their own account. Their Dropbox can then be chosen as a backup destination. An app scoped to its own folder is the one to create: everything Polaris writes then lives in one folder, and nothing else in anybody's Dropbox is reachable from here.",
        docsUrl: "https://www.dropbox.com/developers/reference/getting-started",
        setupLinks: [
            {
                label: "Create an app",
                url: "https://www.dropbox.com/developers/apps/create",
                help: "Scoped access, app folder. Paste the redirect URI below into the app's OAuth 2 redirect URIs."
            },
            {
                label: "Grant the file scopes",
                url: "https://www.dropbox.com/developers/apps",
                help: "On the app's Permissions tab: account_info.read, files.metadata.read/write and files.content.read/write. Submit them before linking, or the token comes back without them."
            }
        ],
        requiresApiKey: true,
        apiKeyLabel: "App secret",
        apiKeyHelp: "Shown on the app's Settings tab, next to the app key."
    },
    {
        slug: "steam",
        name: "Steam",
        category: "Automation",
        summary: "Let people link their Steam account, so game servers can recognise them.",
        description:
            "Steam needs nothing registered: it signs people in over OpenID, so the Connect button on everybody's account works the moment this is switched on. A Web API key is optional and buys one thing - the name and avatar beside a linked account, instead of a seventeen-digit number. An ARK server closed by Steam id can then be opened to somebody by their Polaris name.",
        docsUrl: "https://partner.steamgames.com/doc/features/auth",
        setupLinks: [
            {
                label: "Get a Web API key",
                url: "https://steamcommunity.com/dev/apikey",
                help: "Optional. Only used to read the display name and avatar of an account somebody has linked."
            }
        ],
        requiresApiKey: false,
        apiKeyLabel: "Web API key",
        apiKeyHelp: "Optional. Without it a linked account shows its Steam id rather than its name."
    },
    {
        slug: "epic",
        name: "Epic Games",
        category: "Automation",
        summary: "Let people link their Epic account, so game servers can recognise them.",
        description:
            "Register a product in Epic's developer portal and everyone here gets a Connect button for their own Epic account. Polaris reads the account id and the display name, which is what a server needs to tell one player from another. Games bought on the Epic Store carry no Steam id at all, so for those players this is the only id there is. The longest setup on this screen: Epic wants an application, a verified domain and a brand review before it will let anybody outside your own organisation authorize.",
        docsUrl: "https://dev.epicgames.com/docs/epic-account-services/getting-started",
        setupLinks: [
            {
                label: "Create a product",
                url: "https://dev.epicgames.com/portal",
                help: "Everything else hangs off a product, so it is the first thing to make. The organisation it belongs to is created with your account."
            },
            {
                label: "Create a client, and register the redirect URI on it",
                url: "https://dev.epicgames.com/portal",
                help: "Product settings -> Clients -> New client. Policy type Custom with 'User required' ticked, which is what a client that signs a person in needs; leave every feature disabled, since Polaris only reads who authorized. Paste this into its redirect URLs.",
                values: ["redirectUri"]
            },
            {
                label: "Create the application and link the client to it",
                url: "https://dev.epicgames.com/portal",
                help: "Product settings -> Epic Account Services. Brand settings take the name, the 128x128 logo and these URLs; Permissions needs only Basic Profile, which is always on; Linked clients has to name the client you just made, or the two never meet.",
                values: ["homeUrl", "privacyUrl", "logoUrl"]
            },
            {
                label: "Verify your domain",
                url: "https://dev.epicgames.com/docs/epic-online-services/accounts-and-social/eos-epic-account-services/brand-review/domain-verification",
                help: "Organization settings -> the domain, then the TXT record Epic gives you at your DNS host. Despite the name, the value is public once it is in DNS - it proves the domain is yours and nothing else. The site it points at has to be reachable without signing in and name your organisation and product; the home page above does.",
                values: ["domain"]
            },
            {
                label: "Save the draft, then submit it for review",
                url: "https://dev.epicgames.com/docs/epic-account-services/brand-review/brand-review-process",
                help: "Until it passes, only accounts in your own organisation can authorize - everybody else is turned away, and your own sees an unverified warning it can click through. That is enough to finish this setup and prove it works; the review is what opens it to everyone else."
            },
            {
                label: "Copy the client id and secret",
                url: "https://dev.epicgames.com/portal",
                help: "Product settings -> SDK download and credentials, which lists every client. The secret is shown when the client is created; if it was not kept, make a new client rather than guessing."
            }
        ],
        requiresApiKey: true,
        apiKeyLabel: "Client secret",
        apiKeyHelp: "Shown once when the client is created, next to its id."
    },
    {
        slug: "minecraft",
        name: "Minecraft",
        category: "Automation",
        summary: "Let people link their Minecraft account, so a server can be opened to them by name.",
        description:
            "A separate Entra application from the Microsoft one: this asks only for Xbox sign-in, and Microsoft gates the Minecraft API behind an application it has approved. Once it is connected, linking an account hands Polaris the username as Mojang spells it - which is exactly what a server's player list is keyed by.",
        docsUrl: "https://learn.microsoft.com/entra/identity-platform/quickstart-register-app",
        setupLinks: [
            {
                label: "Register an application",
                url: "https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/CreateApplicationBlade",
                help: "Personal Microsoft accounts only. Paste the redirect URI below into the Web platform."
            },
            {
                label: "Apply for the Minecraft API",
                url: "https://help.minecraft.net/hc/en-us/articles/16254801392141",
                help: "Microsoft approves each application before it may read a Minecraft profile. Without it, linking gets as far as Xbox and stops."
            }
        ],
        requiresApiKey: true,
        apiKeyLabel: "Client secret",
        apiKeyHelp: "The secret's value, not its id. Shown once when it is created."
    },
    {
        slug: "tenor",
        name: "Tenor",
        category: "Productivity",
        summary: "Search GIFs and stickers from the chat composer.",
        description:
            "Adds a GIF and sticker search to the picker in Chat. Without it the picker still works - emoji, the pictures each person has kept, and anything sent by pasting its address - and only the search tab is missing. A chosen GIF is fetched once and stored here like any other attachment, so a conversation never asks Tenor for anything and nobody is told who read what.",
        docsUrl: "https://developers.google.com/tenor/guides/quickstart",
        setupLinks: [
            {
                label: "Create an API key",
                url: "https://console.cloud.google.com/apis/credentials",
                help: "Tenor is a Google API, so the key is an ordinary Google Cloud API key. Enable the Tenor API on the project first."
            }
        ],
        requiresApiKey: true,
        apiKeyLabel: "API key",
        apiKeyHelp: "A Google Cloud API key with the Tenor API enabled on its project."
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
