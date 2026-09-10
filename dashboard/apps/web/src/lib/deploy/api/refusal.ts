/**
 * What the programmatic Deploy surface is allowed to say when something fails.
 *
 * Two kinds of failure reach it and they must not be told apart by accident. A
 * refusal - "that service has no domain with that id", "this key is confined to
 * another project" - is written for whoever holds the key and reaches them as
 * written, with the status that says what kind of refusal it is. Everything else
 * is the inside of the instance: a daemon that answered 502 with a path in the
 * body, a query that failed, a host that could not be reached. Those go to the
 * server log and the caller gets a sentence that says which operation failed.
 *
 * The service layer throws plain `Error`s whose messages the dashboard already
 * shows to the same person on the same authority ("That deploy has already
 * finished"), and those are worth passing on - a CLI that answers every refused
 * deploy with "could not deploy" is one nobody can act on. So a plain error with a
 * short, single-line message that names nothing internal is treated as a
 * refusal, and anything that looks like it came from beneath the service layer
 * is not. The test for "looks like" is deliberately wide: a useful message
 * swallowed costs a retry, a leaked one costs a path or a host name.
 */

/** A refusal written for the caller, with the HTTP status that classifies it. */
export class DeployApiRefusal extends Error {
    constructor(
        readonly status: number,
        message: string
    ) {
        super(message);
        this.name = "DeployApiRefusal";
    }
}

/** The service layer's own "not found" sentences, from the access checks and the
 *  owner-scoped queries. Reported as one 404 whichever it was: whether a project
 *  exists is not something a caller who cannot see it is owed. */
const NOT_FOUND = /^(?:Project|Environment|Service|Application|Database|Domain|Deployment) not found$/;

/** What a message from beneath the service layer looks like: paths, daemons,
 *  status codes in brackets, stack frames and multi-line bodies. */
const INTERNALS =
    /[\\/]|\n|\bhostd\b|\bdaemon\b|\bdocker\b|\bprisma\b|\bssh\b|\bsocket\b|\bstd(?:out|err)\b|\(\d{3}\)|\bat \w+ \(|\bundefined\b|\bnull\b/i;

/** An errno code (ECONNREFUSED, EACCES). Case matters here and nowhere else:
 *  read without it, "example" is an errno. */
const ERRNO = /\bE[A-Z]{3,}\b/;

/** The longest service-layer sentence passed on as written. */
const MAX_MESSAGE = 300;

export interface PublicFailure {
    readonly status: number;
    readonly message: string;
}

/**
 * Turn whatever was thrown into what the caller is told.
 *
 * `operation` finishes the sentence used when the real reason stays in the log:
 * "deploy the service" becomes "Polaris could not deploy the service. The reason
 * has been logged on the server."
 */
export function publicFailure(caught: unknown, operation: string): PublicFailure {
    if (caught instanceof DeployApiRefusal) {
        return { status: caught.status, message: caught.message };
    }
    const message = caught instanceof Error ? caught.message.trim() : "";
    if (NOT_FOUND.test(message)) return { status: 404, message: "Not found" };
    // A subclass is somebody else's error type - the ORM, the runtime, a driver -
    // and a `code` is an errno or a driver's own classification. Neither is a
    // sentence the service layer wrote for a person.
    const plain =
        caught instanceof Error &&
        Object.getPrototypeOf(caught) === Error.prototype &&
        !("code" in caught);
    if (
        plain &&
        message &&
        message.length <= MAX_MESSAGE &&
        !INTERNALS.test(message) &&
        !ERRNO.test(message)
    ) {
        return { status: 422, message };
    }
    console.error(`deploy api: could not ${operation}:`, caught);
    return {
        status: 500,
        message: `Polaris could not ${operation}. The reason has been logged on the server.`
    };
}
