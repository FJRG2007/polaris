/**
 * What every managed host Polaris creates an instance at has in common: a
 * create that can be taken again, a read of how it is going, and a delete -
 * each one request (or a few) against the provider's own API with the user's
 * key. `service.ts` drives the lifecycle; a provider module only speaks its API.
 *
 * Every answer is checked against a schema before anything in it is used, and a
 * refusal is said with the provider's own words, never with the key.
 */

import type { z } from "zod";
import { CloudError } from "./errors";
import type * as core from "@polaris/core";
import type { CloudFetch } from "./cloudamqp";

/** What a create holds while it is under way (the sealed `cloud` blob). */
export interface CloudSecrets {
    readonly apiKey?: string;
    readonly plan?: string;
    readonly region?: string;
    /** The instance's name there, which is how a repeated create finds it. */
    readonly remoteName?: string;
    /** The Neon organization, the Supabase organization slug, the Upstash email. */
    readonly account?: string;
    /** A database password Polaris chose before the create (Supabase). */
    readonly dbPassword?: string;
}

/** An instance as the provider describes it. */
export interface CloudInstance {
    readonly id: string;
    /** True once it takes connections and `endpoint` is set. */
    readonly ready: boolean;
    readonly endpoint: core.DataEndpoint | null;
}

export interface CloudCreator {
    /** The provider's name, as the screen says it. */
    readonly label: string;
    /** Create it, or find the one this name already made. */
    create(request: CloudFetch, cloud: CloudSecrets): Promise<CloudInstance>;
    get(request: CloudFetch, cloud: CloudSecrets, id: string): Promise<CloudInstance>;
    /** The id of the instance by its name there, when the provider can be asked. */
    find(request: CloudFetch, cloud: CloudSecrets): Promise<string | null>;
    /** Delete it; one already gone counts as deleted. */
    remove(request: CloudFetch, cloud: CloudSecrets, id: string): Promise<void>;
}

/** The longest provider message shown, so a page of HTML is not. */
const MESSAGE_MAX = 300;

/** The provider's own explanation in an error body, if it gave one. */
export function providerMessage(body: string): string {
    let text = body;
    try {
        const parsed = JSON.parse(body) as unknown;
        if (typeof parsed === "string") text = parsed;
        else if (parsed && typeof parsed === "object") {
            const value = parsed as Record<string, unknown>;
            const found = [value.message, value.error, value.detail, value.reason, value.msg].find(
                (one) => typeof one === "string" && one.trim()
            );
            text = typeof found === "string" ? found : "";
        }
    } catch {
        // Not JSON: plain text is said as it is, markup is not said at all.
        if (/<[a-z!/]/i.test(text)) text = "";
    }
    const flat = text.replace(/\s+/g, " ").trim();
    return flat.length > MESSAGE_MAX ? `${flat.slice(0, MESSAGE_MAX - 3)}...` : flat;
}

/**
 * One request to a provider: a refused key, any other refusal (with what the
 * provider said) and an answer that is not what its documentation describes
 * each end as a `CloudError` the screen has words for.
 */
export async function providerCall<S extends z.ZodTypeAny>(
    request: CloudFetch,
    label: string,
    url: string,
    init: RequestInit,
    schema: S,
    accept404 = false
): Promise<z.output<S> | null> {
    let response: Response;
    try {
        response = await request(url, init);
    } catch {
        throw new CloudError("nothingAnswered");
    }
    if (accept404 && response.status === 404) return null;
    if (response.status === 401 || response.status === 403) {
        throw new CloudError("providerKeyRefused", { provider: label });
    }
    const body = await response.text().catch(() => "");
    if (!response.ok) {
        const message = providerMessage(body);
        throw new CloudError(message ? "providerRefused" : "providerStatus", {
            provider: label,
            status: response.status,
            message
        });
    }
    let parsed: unknown;
    try {
        parsed = body ? JSON.parse(body) : null;
    } catch {
        throw new CloudError("providerUnreadable", { provider: label });
    }
    const checked = schema.safeParse(parsed);
    if (!checked.success) throw new CloudError("providerUnreadable", { provider: label });
    return checked.data as z.output<S>;
}

/** True when a create was refused for what was asked, so retrying cannot help. */
export function refusedForGood(error: unknown): boolean {
    if (!(error instanceof CloudError)) return false;
    if (error.key !== "providerRefused" && error.key !== "providerStatus") return false;
    const status = Number(error.params.status);
    return status >= 400 && status < 500 && status !== 408 && status !== 429;
}
