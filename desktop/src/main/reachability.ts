/**
 * Why the Polaris could not be opened, in words. Pure, so the sentences are
 * tested without a network.
 *
 * Chromium reports a failed load as a code (`ERR_NAME_NOT_RESOLVED`); the reader
 * needs to know which of their own mistakes or circumstances it is - a typo, an
 * offline laptop, a server that is down, a certificate this computer does not
 * trust - and what to do about it.
 */

/** The Chromium error code inside a message or description, if there is one. */
export function netErrorCode(text: string): string | null {
    return /ERR_[A-Z0-9_]+/.exec(text)?.[0] ?? null;
}

/** A sentence for a failed load of `host`, from Chromium's error code. */
export function describeNetError(code: string | null, host: string): string {
    if (!code) return `Could not reach ${host}.`;
    if (code === "ERR_NAME_NOT_RESOLVED" || code === "ERR_NAME_RESOLUTION_FAILED") {
        return `${host} does not resolve to a server. Check the address for a typo.`;
    }
    if (code === "ERR_INTERNET_DISCONNECTED" || code === "ERR_NETWORK_CHANGED") {
        return "This computer is not connected to a network.";
    }
    if (code === "ERR_CONNECTION_REFUSED" || code === "ERR_CONNECTION_RESET" || code === "ERR_CONNECTION_CLOSED") {
        return `Nothing is answering at ${host}. The server may be down or restarting.`;
    }
    if (code === "ERR_CONNECTION_TIMED_OUT" || code === "ERR_TIMED_OUT" || code === "ERR_ADDRESS_UNREACHABLE") {
        return `${host} did not answer in time. It may be off, or only reachable from another network.`;
    }
    if (code.startsWith("ERR_CERT_") || code === "ERR_SSL_PROTOCOL_ERROR" || code === "ERR_BAD_SSL_CLIENT_AUTH_CERT") {
        return `The certificate of ${host} is not trusted by this computer. Use an address of your Polaris that has a trusted certificate.`;
    }
    return `Could not reach ${host} (${code}).`;
}

/** What the health probe at `/api/health` said about an address. */
export type ProbeVerdict =
    | { readonly ok: true; }
    | { readonly ok: false; readonly reason: "not-ready" | "not-polaris"; };

/**
 * Whether a response to `GET /api/health` came from a Polaris. It answers
 * `{"status":"ok"}` when it is serving and `{"status":"error"}` with a 503 when
 * it is up but its database is not; anything else is some other server.
 */
export function classifyHealth(status: number, body: unknown): ProbeVerdict {
    const said = body && typeof body === "object" ? (body as { status?: unknown; }).status : undefined;
    if (status === 200 && said === "ok") return { ok: true };
    if (status === 503 && said === "error") return { ok: false, reason: "not-ready" };
    return { ok: false, reason: "not-polaris" };
}

export function describeProbe(verdict: ProbeVerdict, host: string): string | null {
    if (verdict.ok) return null;
    return verdict.reason === "not-ready"
        ? `Polaris at ${host} is starting, or cannot reach its database yet. Try again in a minute.`
        : `Something answered at ${host}, but it is not Polaris.`;
}
