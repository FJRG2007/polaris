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

export type ConnectionProviderSlug = "github" | "google" | "microsoft" | "dropbox" | "steam" | "epic" | "minecraft";

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
    /**
     * Whether this service's word is taken as proof that somebody reads mail at
     * the address it hands over, on a deployment that has not said otherwise.
     *
     * Undefined for a service that vouches for no address at all: there is
     * nothing to take anybody's word about, so no switch is offered for it.
     *
     * True only where the provider states in its own response that it confirmed
     * the address, and where losing that account is already as bad as losing a
     * Polaris one. False elsewhere - the address is still held for its owner,
     * because that is what stops a second account being created under it, but it
     * arrives unconfirmed and the owner proves it the ordinary way.
     */
    emailTrustDefault?: boolean;
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
        signInDefault: true,
        // GitHub only lets an address be published once it has been confirmed, so
        // the one it hands back is one GitHub itself proved.
        emailTrustDefault: true
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
        signInDefault: true,
        // Google states on the token itself whether it confirmed the address, and
        // nothing is held unless it says so.
        emailTrustDefault: true
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
            "This account often reaches a work mailbox and a company tenant. It is linked here to store files, and allowing it to sign in makes it a way into Polaris too.",
        // Graph returns the mailbox on the account without saying whether anybody
        // proved they read it, and on a tenant an administrator can set it to
        // anything. The address is held; confirming it stays the owner's to do.
        emailTrustDefault: false
    },
    {
        slug: "steam",
        name: "Steam",
        summary: "Be let onto a game server without anybody asking for your Steam id.",
        description:
            "ARK closes its door by Steam id, not by name. Linking your account is what lets whoever runs a server add you by your Polaris name and have the right id arrive with it. Polaris reads nothing else from Steam and can do nothing with your account.",
        acceptsToken: false,
        defaultLimit: 1,
        // Reads as "connects Steam under Integrations" on the card that cannot
        // offer a link yet. Steam speaks OpenID rather than OAuth, so there is no
        // application to register - switching it on is the whole of it.
        requires: "Steam",
        // A gaming account, phished at scale and shared between friends far more
        // often than an email one. It is linked here to be recognised on a game
        // server, and that is all it should ever unlock.
        signInDefault: false,
        signInWarning:
            "Steam accounts are traded and phished more than most. This one is linked to be recognised on a game server; letting it sign in makes it a way into Polaris as well."
    },
    {
        slug: "epic",
        name: "Epic Games",
        summary: "Be recognised on a game server you own the game on through Epic.",
        description:
            "Games bought on the Epic Store identify a player by an Epic account id rather than a Steam one. Linking yours is what lets whoever runs a server know which of those you are. Polaris reads your account id and display name and nothing else.",
        acceptsToken: false,
        defaultLimit: 1,
        requires: "an Epic product",
        // Another gaming account, and worth no more as a way into Polaris than
        // the Steam one beside it.
        signInDefault: false,
        signInWarning:
            "This account is linked to be recognised on a game server. Letting it sign in makes it a way into Polaris as well."
    },
    {
        slug: "minecraft",
        name: "Minecraft",
        summary: "Be added to a Minecraft server by name, spelled the way Mojang spells it.",
        description:
            "A Minecraft server lets people in by username, and one wrong letter is a player who cannot join with nothing saying why. Linking your account hands over the name and the account id it belongs to, so whoever runs a server can add you by your Polaris name instead. Polaris reads your profile once and keeps nothing it could act with.",
        acceptsToken: false,
        defaultLimit: 1,
        requires: "a Microsoft application approved for the Minecraft API",
        // The account behind it is a Microsoft one, with everything that reaches -
        // and it is linked here to name a Minecraft profile.
        signInDefault: false,
        signInWarning:
            "The account behind a Minecraft profile is a Microsoft account, which often reaches an inbox as well. It is linked here to name a player on a server."
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
            "This account is linked here to store files. Allowing it to sign in makes whoever holds it able to reach Polaris as well.",
        // Dropbox does say it confirmed the address. It arrives off all the same:
        // this is a file store somebody linked to keep backups in, and it is not
        // what a deployment should be taking anybody's identity from by default.
        emailTrustDefault: false
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

/** The Setting key holding whether this service's word confirms the address it
 *  hands over. Absent, the provider's own default applies. */
export function connectionEmailTrustKey(slug: string): string {
    return `connections.${slug}.email-trust`;
}
