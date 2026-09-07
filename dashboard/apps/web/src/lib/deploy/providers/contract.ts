/**
 * What a place that runs somebody else's services has to be able to answer.
 *
 * Four questions to watch one, and they are the only four every provider can
 * answer about a service it builds and serves: what have you got, which of it am
 * I looking at, what state is it in, and do it again. Anything past that is one
 * vendor's idea - Vercel has previews and instant rollback, Railway has replicas
 * and volumes - and a control plane that modelled those would be a worse copy of
 * each of their dashboards.
 *
 * Three more to move one, and they are there because a service moving between a
 * Polaris server and a provider is exactly three things: a repository, a set of
 * variables, and a domain. The repository and the variables are what a driver can
 * answer; the domain is DNS and belongs to whoever owns the name. Without these a
 * move is somebody copying thirty secrets between two dashboards by hand, which
 * is the part of moving a service that actually goes wrong.
 *
 * The deliberate omission is the build. Polaris does not build, upload or
 * configure anything here: what goes into a release is the provider's, decided
 * by the repository they are already connected to. That is the whole point of
 * running something there rather than here, and a driver that started sending
 * build settings would be quietly taking over a thing somebody chose not to give
 * it.
 *
 * Server-only: a driver holds somebody's token and talks to their account.
 */

/** How a release is going, in the words Polaris uses for every provider. */
export type ExternalStatus = "queued" | "building" | "live" | "failed" | "cancelled" | "unknown";

/**
 * Something that could be pointed at: a project, and whatever else that provider
 * needs to name one thing inside it.
 *
 * A choice that can be added says so itself, in `externalId` and `ref` - the two
 * values the row is stored with. That is deliberate and it replaced a screen that
 * knew each provider's shape: it had a branch reading "if this is Railway, the
 * second level is the service and the environment travels with it", which is a
 * sentence about Railway living in a dialog, and the next provider added a second
 * one. A driver knows what names one of its services; nothing else should have to.
 */
export interface ProviderChoice {
    /** Their id for it, kept on the row. */
    readonly id: string;
    readonly name: string;
    /** What else has to be chosen before this is a single deployable thing, where
     *  the provider has such a level. Empty when the project is enough. */
    readonly children?: readonly ProviderChoice[];
    /** What to store as the row's id when this is the thing chosen. Absent on a
     *  choice that is only a heading - a Railway project, an ECS cluster - which
     *  is also what says it cannot be picked on its own. */
    readonly externalId?: string;
    /** Everything else that names it there, stored beside the id. */
    readonly ref?: ProviderRef;
}

/** The last release, as a screen shows it. */
export interface ExternalState {
    readonly status: ExternalStatus;
    /** Where it can be reached, with a scheme. Null when the provider gives none. */
    readonly url: string | null;
    /** Their own page for the release, which is where "open it there" goes. */
    readonly inspectUrl: string | null;
    readonly at: Date | null;
    readonly commitSha: string | null;
    readonly commitMessage: string | null;
    /** Their words for why it failed, where it did. */
    readonly error: string | null;
}

/** What went wrong, and whether the credential is the problem - the same
 *  distinction every other integration here keeps, and for the same reason: a
 *  revoked token has to be said on the link, and a bad morning must not be. */
export class ProviderError extends Error {
    readonly kind: "unauthorized" | "refused" | "unreachable";

    constructor(message: string, kind: ProviderError["kind"]) {
        super(message);
        this.name = "ProviderError";
        this.kind = kind;
    }
}

/**
 * Whatever a provider needs to point at one service, past the project id.
 *
 * Opaque above the driver: a team for Vercel, a service and an environment for
 * Railway, and something else again for the next one. Stored as JSON on the row
 * and handed back to the driver that wrote it.
 */
export type ProviderRef = Readonly<Record<string, string>>;

export interface ProviderDriver {
    readonly provider: string;
    /** Everything this token can see, for the screen that asks what to add. */
    choices(token: string): Promise<ProviderChoice[]>;
    /** What one service is doing now. */
    state(token: string, externalId: string, ref: ProviderRef): Promise<ExternalState>;
    /** Build and release it again, with whatever the provider already has. */
    deploy(token: string, externalId: string, ref: ProviderRef): Promise<void>;

    /**
     * The repository the provider builds, for a service being brought home.
     *
     * Null where the provider will not say - which is a real answer and not a
     * failure: a project deployed straight from somebody's command line has no
     * repository behind it, and Railway's public API does not expose the one a
     * service is connected to at all. The move then asks for it, which is one
     * field somebody can read off their own dashboard.
     */
    source(token: string, externalId: string, ref: ProviderRef): Promise<ServiceSource | null>;

    /**
     * What it is built and run with, for a service being brought home.
     *
     * Only what is worth carrying: a provider's own variables and any reference
     * that means nothing outside their project are left where they are. Values
     * the provider will not decrypt are absent rather than empty - a secret that
     * silently became "" is worse than one that is missing and said so.
     */
    variables(token: string, externalId: string, ref: ProviderRef): Promise<Record<string, string>>;

    /**
     * Put these on it, replacing any of the same name and leaving the rest.
     *
     * Never a replacement of the whole set. This is reached by a move carrying
     * variables from somewhere else, and a move that also deleted whatever was
     * already there would be one nobody could undo.
     */
    putVariables(
        token: string,
        externalId: string,
        ref: ProviderRef,
        values: Readonly<Record<string, string>>
    ): Promise<void>;
}

/** Where a service is built from. */
export interface ServiceSource {
    /** `owner/name`, as every git host writes it. */
    readonly repo: string;
    /** The branch they build, or "" where the provider does not say. */
    readonly branch: string;
    /** The whole address, where one can be built. Empty for a host Polaris
     *  cannot assume - which is anything but GitHub. */
    readonly url: string;
}
