/**
 * The outside services a person can link an account of, and what linking one
 * buys them. Code, not data: each entry says how an account is authorized and
 * what stops working when it is unlinked. A matching Integration row records the
 * application the operator connected, without which the provider cannot be
 * offered at all.
 */

export type ConnectionProviderSlug = "github" | "google";

export interface ConnectionProvider {
    slug: ConnectionProviderSlug;
    name: string;
    /** One line on the card, in the second person: this is somebody's own account. */
    summary: string;
    /** What the link is used for, shown under the accounts. */
    description: string;
    /** Whether a personal access token may be pasted instead of authorizing. */
    acceptsToken: boolean;
    tokenLabel?: string;
    tokenHelp?: string;
    /** Where to get one, for the token form. */
    tokenUrl?: string;
    /** How many accounts one person may link when the operator has set no limit. */
    defaultLimit: number;
    /** What the operator has to connect first, named so the empty state can say it. */
    requires: string;
}

export const CONNECTION_PROVIDERS: readonly ConnectionProvider[] = [
    {
        slug: "github",
        name: "GitHub",
        summary: "Deploy your repositories and let a runner pool serve them.",
        description:
            "Polaris lists the repositories your account reaches, builds the private ones, and can point a runner pool at them. Unlinking stops all three.",
        acceptsToken: true,
        tokenLabel: "Personal access token",
        tokenHelp:
            "A fine-grained token with Contents: Read on the repositories you want to deploy, or a classic token with the 'repo' scope.",
        tokenUrl: "https://github.com/settings/tokens",
        defaultLimit: 1,
        requires: "a GitHub App"
    },
    {
        slug: "google",
        name: "Google",
        summary: "Show your calendar next to your work.",
        description:
            "Read-only access to your calendar, so the schedule views can put your meetings beside your tasks. Polaris never writes to it.",
        acceptsToken: false,
        defaultLimit: 1,
        requires: "a Google OAuth client"
    }
];

export function findConnectionProvider(slug: string): ConnectionProvider | undefined {
    return CONNECTION_PROVIDERS.find((entry) => entry.slug === slug);
}

/** The Setting key holding how many accounts of one provider a person may link. */
export function connectionLimitKey(slug: string): string {
    return `connections.${slug}.limit`;
}
