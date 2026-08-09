/**
 * The outside services a person can link an account of, what linking one buys
 * them, and whether that account may also sign them in.
 *
 * Code, not data: each entry says how an account is authorized, what stops
 * working when it is unlinked, and what Polaris thinks of it as a way in. A
 * matching Integration row records the application the operator connected,
 * without which the provider cannot be offered at all.
 *
 * It lives in the domain layer rather than beside the screens because the auth
 * package names these providers too - a sign-in has to be recorded as the
 * service that proved it - and a provider added in two places is a provider that
 * will one day be half added.
 */

export type ConnectionProviderSlug = "github" | "google" | "microsoft" | "dropbox";

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
    /**
     * Whether this service arrives allowed as a way in, on the platform and on
     * each newly linked account.
     *
     * True for the services Polaris trusts with a sign-in, so an operator who
     * connects the application does not then have to find two more switches
     * before anybody can use it. False for one whose own account is easier to
     * take over than a Polaris one: that arrives closed on both sides, with
     * signInWarning saying why, and only opens if somebody decides it should.
     */
    signInDefault: boolean;
    /**
     * Why this service is not recommended as a way in, or undefined when there
     * is nothing to warn about. Shown next to both switches, so the person
     * turning it on reads the reason first.
     */
    signInWarning?: string;
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
        requires: "a GitHub App",
        signInDefault: true
    },
    {
        slug: "google",
        name: "Google",
        summary: "Show your calendar next to your work, and keep backups in your Drive.",
        description:
            "Read-only access to your calendar, so the schedule views can put your meetings beside your tasks. Polaris never writes to it. Connecting Drive as a backup destination asks separately, and only for the folder it creates.",
        acceptsToken: false,
        defaultLimit: 1,
        requires: "a Google OAuth client",
        signInDefault: true
    },
    {
        slug: "microsoft",
        name: "Microsoft",
        summary: "Keep backups in your OneDrive.",
        description:
            "Access to the files Polaris creates in your OneDrive, so a backup can be copied somewhere that survives this machine. Unlinking stops the copies; the ones already there stay where they are.",
        acceptsToken: false,
        defaultLimit: 1,
        requires: "a Microsoft Entra application",
        // An account that unlocks a work mailbox and a company tenant is a larger
        // prize than a Polaris one, and it is linked here for file storage - not
        // as a way in. Somebody can still allow it, having read why.
        signInDefault: false,
        signInWarning:
            "This account often reaches a work mailbox and a company tenant. It is linked here to store files, and allowing it to sign in makes it a way into Polaris too."
    },
    {
        slug: "dropbox",
        name: "Dropbox",
        summary: "Keep backups in your Dropbox.",
        description:
            "Access to the folder Polaris creates in your Dropbox, so a backup can be copied off this machine. Unlinking stops the copies; the ones already there stay where they are.",
        acceptsToken: false,
        defaultLimit: 1,
        requires: "a Dropbox app",
        signInDefault: false,
        signInWarning:
            "This account is linked here to store files. Allowing it to sign in makes whoever holds it able to reach Polaris as well."
    }
];

export function findConnectionProvider(slug: string): ConnectionProvider | undefined {
    return CONNECTION_PROVIDERS.find((entry) => entry.slug === slug);
}

/** The Setting key holding how many accounts of one provider a person may link. */
export function connectionLimitKey(slug: string): string {
    return `connections.${slug}.limit`;
}

/** The Setting key holding whether this service may sign anybody in here at all.
 *  Absent, the provider's own default applies. */
export function connectionSignInKey(slug: string): string {
    return `connections.${slug}.signin`;
}
