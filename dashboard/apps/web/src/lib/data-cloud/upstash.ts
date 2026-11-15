/**
 * Redis at Upstash, with the account email and a Developer API key.
 *
 * Upstash Developer API, as documented (HTTP Basic `EMAIL:API_KEY`,
 * https://upstash.com/docs/devops/developer-api/authentication):
 * - https://upstash.com/docs/devops/developer-api/redis/create_database_global -
 *   `POST https://api.upstash.com/v2/redis/database` with `database_name`,
 *   `platform` (`aws` or `gcp`), `primary_region` and `tls`; answers with
 *   `database_id`, `endpoint`, `port`, `password` and `state`.
 * - https://upstash.com/docs/devops/developer-api/redis/list_databases -
 *   `GET /v2/redis/databases`, which is also how one database is read: the
 *   single-database read is not on the pages above.
 * - https://upstash.com/docs/devops/developer-api/redis/delete_database
 *
 * Of Upstash's other products only Vector has a provisioning API there, and
 * Polaris offers no vector engine for it to be a place of; see
 * docs/data-cloud-providers.md.
 */

import { z } from "zod";
import * as core from "@polaris/core";
import type { CloudFetch } from "./cloudamqp";
import { providerCall, type CloudCreator, type CloudInstance, type CloudSecrets } from "./managed";

export const UPSTASH_API = "https://api.upstash.com/v2/redis";
const LABEL = "Upstash";

const databaseSchema = z.object({
    database_id: z.string().min(1),
    database_name: z.string().default(""),
    endpoint: z.string().default(""),
    port: z.number().int().nonnegative().default(0),
    password: z.string().optional(),
    state: z.string().default(""),
    tls: z.boolean().optional()
});
type UpstashDatabase = z.infer<typeof databaseSchema>;

function headers(cloud: CloudSecrets): Record<string, string> {
    const basic = Buffer.from(`${cloud.account ?? ""}:${cloud.apiKey ?? ""}`).toString("base64");
    return {
        authorization: `Basic ${basic}`,
        accept: "application/json",
        "content-type": "application/json"
    };
}

/** GCP's region ids have no dash before their number (`us-central1`); AWS's do. */
export function upstashPlatform(region: string): "aws" | "gcp" {
    return /-\d+$/.test(region) ? "aws" : "gcp";
}

function describe(one: UpstashDatabase): CloudInstance {
    const ready = one.state === "active" && Boolean(one.endpoint && one.port && one.password);
    if (!ready) return { id: one.database_id, ready: false, endpoint: null };
    // Password-only AUTH, the way Polaris's own Redis URLs read.
    const scheme = one.tls === false ? "redis" : "rediss";
    const url = `${scheme}://:${encodeURIComponent(one.password!)}@${one.endpoint}:${one.port}`;
    return {
        id: one.database_id,
        ready: true,
        endpoint: core.cloudEndpoint(
            core.cloudConnectSchema.parse({
                environmentId: "00000000-0000-4000-8000-000000000000",
                name: "cloud",
                engine: "redis",
                provider: "upstash",
                url
            })
        )
    };
}

async function list(request: CloudFetch, cloud: CloudSecrets): Promise<UpstashDatabase[]> {
    const rows = await providerCall(
        request,
        LABEL,
        `${UPSTASH_API}/databases`,
        { method: "GET", headers: headers(cloud) },
        z.array(databaseSchema)
    );
    return rows ?? [];
}

export const upstash: CloudCreator = {
    label: LABEL,
    async create(request: CloudFetch, cloud: CloudSecrets): Promise<CloudInstance> {
        const same = (await list(request, cloud)).find(
            (one) => one.database_name === cloud.remoteName
        );
        if (same) return describe(same);
        const region = cloud.region ?? "";
        const body = await providerCall(
            request,
            LABEL,
            `${UPSTASH_API}/database`,
            {
                method: "POST",
                headers: headers(cloud),
                body: JSON.stringify({
                    database_name: cloud.remoteName,
                    platform: upstashPlatform(region),
                    primary_region: region,
                    tls: true
                })
            },
            databaseSchema
        );
        return describe(body!);
    },
    async get(request: CloudFetch, cloud: CloudSecrets, id: string): Promise<CloudInstance> {
        const found = (await list(request, cloud)).find((one) => one.database_id === id);
        return found ? describe(found) : { id, ready: false, endpoint: null };
    },
    async find(request: CloudFetch, cloud: CloudSecrets): Promise<string | null> {
        const found = (await list(request, cloud)).find(
            (one) => one.database_name === cloud.remoteName
        );
        return found?.database_id ?? null;
    },
    async remove(request: CloudFetch, cloud: CloudSecrets, id: string): Promise<void> {
        await providerCall(
            request,
            LABEL,
            `${UPSTASH_API}/database/${encodeURIComponent(id)}`,
            { method: "DELETE", headers: headers(cloud) },
            z.unknown(),
            true
        );
    }
};
