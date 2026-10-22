/**
 * CloudAMQP's customer API, with the user's own API key.
 *
 * Documented at https://docs.cloudamqp.com/cloudamqp_api.html and exercised the
 * same way by CloudAMQP's own Terraform provider
 * (github.com/cloudamqp/terraform-provider-cloudamqp, api/instance.go): basic
 * auth with an empty user and the key as the password, `POST /api/instances`
 * with `name`, `plan`, `region` and `tags`, `GET /api/instances/{id}` until
 * `ready` is true, and `DELETE /api/instances/{id}`.
 */

import { CloudError, type CloudErrorKey } from "./errors";

export const CLOUDAMQP_API = "https://customer.cloudamqp.com/api/instances";

/** A request to an address the caller has already vetted. */
export type CloudFetch = (url: string, init: RequestInit) => Promise<Response>;

export interface CloudAmqpInstance {
    readonly id: string;
    readonly name: string;
    /** The AMQP URL with its credentials, once the instance has one. */
    readonly url: string;
    readonly ready: boolean;
}

function authorization(apiKey: string): string {
    return `Basic ${Buffer.from(`:${apiKey}`).toString("base64")}`;
}

/** Throws with what CloudAMQP answered, without echoing the key. */
async function expectOk(response: Response, failed: CloudErrorKey): Promise<void> {
    if (response.ok) return;
    if (response.status === 401 || response.status === 403) throw new CloudError("amqpKeyRefused");
    throw new CloudError(failed, { status: response.status });
}

function readInstance(raw: unknown): CloudAmqpInstance {
    const value = (raw ?? {}) as Record<string, unknown>;
    return {
        id: String(value.id ?? ""),
        name: typeof value.name === "string" ? value.name : "",
        url: typeof value.url === "string" ? value.url : "",
        ready: value.ready === true
    };
}

/**
 * Create an instance, or find the one this name already made: a create that
 * timed out after CloudAMQP accepted it is retried without a second instance.
 */
export async function createCloudAmqpInstance(
    request: CloudFetch,
    apiKey: string,
    input: { readonly name: string; readonly plan: string; readonly region: string }
): Promise<CloudAmqpInstance> {
    const same = await findCloudAmqpInstance(request, apiKey, input.name);
    if (same) return same;

    const created = await request(CLOUDAMQP_API, {
        method: "POST",
        headers: {
            authorization: authorization(apiKey),
            accept: "application/json",
            "content-type": "application/json"
        },
        body: JSON.stringify({
            name: input.name,
            plan: input.plan,
            region: input.region,
            tags: ["polaris"]
        })
    });
    await expectOk(created, "amqpCreateFailed");
    return readInstance(await created.json());
}

/** The instance by the name it was created under, if there is one. */
export async function findCloudAmqpInstance(
    request: CloudFetch,
    apiKey: string,
    name: string
): Promise<CloudAmqpInstance | null> {
    const listed = await request(CLOUDAMQP_API, {
        method: "GET",
        headers: { authorization: authorization(apiKey), accept: "application/json" }
    });
    await expectOk(listed, "amqpListFailed");
    const existing = ((await listed.json()) as unknown[]).map(readInstance);
    return existing.find((one) => one.name === name) ?? null;
}

export async function getCloudAmqpInstance(
    request: CloudFetch,
    apiKey: string,
    id: string
): Promise<CloudAmqpInstance> {
    const response = await request(`${CLOUDAMQP_API}/${encodeURIComponent(id)}`, {
        method: "GET",
        headers: { authorization: authorization(apiKey), accept: "application/json" }
    });
    await expectOk(response, "amqpReadFailed");
    return readInstance(await response.json());
}

/** Delete an instance. One already gone counts as deleted. */
export async function deleteCloudAmqpInstance(
    request: CloudFetch,
    apiKey: string,
    id: string
): Promise<void> {
    const response = await request(`${CLOUDAMQP_API}/${encodeURIComponent(id)}`, {
        method: "DELETE",
        headers: { authorization: authorization(apiKey) }
    });
    if (response.status === 404) return;
    await expectOk(response, "amqpDeleteFailed");
}
