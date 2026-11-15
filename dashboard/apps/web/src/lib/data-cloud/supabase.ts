/**
 * PostgreSQL at Supabase, with the user's own access token.
 *
 * Supabase Management API, as documented (base `https://api.supabase.com`,
 * `Authorization: Bearer <token>`, https://supabase.com/docs/reference/api/introduction):
 * - https://supabase.com/docs/reference/api/v1-create-a-project -
 *   `POST /v1/projects` with `db_pass`, `name`, `organization_slug` and
 *   `region`; answers with the project `ref` and `status`.
 * - https://supabase.com/docs/reference/api/v1-get-project - `status`.
 * - https://supabase.com/docs/reference/api/v1-get-pooler-config -
 *   `GET /v1/projects/{ref}/config/database/pooler`: `db_user`, `db_host`,
 *   `db_port`, `db_name` per pooler. Whether its `connection_string` carries the
 *   password is not documented, so the URL is assembled from those fields and
 *   the password Polaris chose.
 * - https://supabase.com/docs/reference/api/v1-delete-a-project
 *
 * The documented statuses do not say which one means ready; `ACTIVE_HEALTHY`
 * is taken as it, and the pooler is only asked after it. Listing projects is
 * not on the pages above, so a create whose answer was lost is not found again.
 */

import { z } from "zod";
import { postgresEndpoint } from "./neon";
import type { CloudFetch } from "./cloudamqp";
import { providerCall, type CloudCreator, type CloudInstance, type CloudSecrets } from "./managed";

export const SUPABASE_API = "https://api.supabase.com/v1";
const LABEL = "Supabase";
const READY = "ACTIVE_HEALTHY";

const projectSchema = z.object({ ref: z.string().min(1), status: z.string().default("") });
const poolerSchema = z.array(
    z.object({
        database_type: z.string().optional(),
        db_user: z.string().min(1),
        db_host: z.string().min(1),
        db_port: z.number().int().positive(),
        db_name: z.string().min(1)
    })
);

function headers(cloud: CloudSecrets): Record<string, string> {
    return {
        authorization: `Bearer ${cloud.apiKey ?? ""}`,
        accept: "application/json",
        "content-type": "application/json"
    };
}

async function describe(
    request: CloudFetch,
    cloud: CloudSecrets,
    ref: string,
    status: string
): Promise<CloudInstance> {
    if (status !== READY) return { id: ref, ready: false, endpoint: null };
    const poolers = await providerCall(
        request,
        LABEL,
        `${SUPABASE_API}/projects/${encodeURIComponent(ref)}/config/database/pooler`,
        { method: "GET", headers: headers(cloud) },
        poolerSchema
    );
    const pooler = poolers!.find((one) => one.database_type !== "READ_REPLICA") ?? poolers![0];
    if (!pooler || !cloud.dbPassword) return { id: ref, ready: false, endpoint: null };
    const user = encodeURIComponent(pooler.db_user);
    const secret = encodeURIComponent(cloud.dbPassword);
    const url = `postgresql://${user}:${secret}@${pooler.db_host}:${pooler.db_port}/${encodeURIComponent(pooler.db_name)}`;
    return { id: ref, ready: true, endpoint: postgresEndpoint(url) };
}

export const supabase: CloudCreator = {
    label: LABEL,
    async create(request: CloudFetch, cloud: CloudSecrets): Promise<CloudInstance> {
        const body = await providerCall(
            request,
            LABEL,
            `${SUPABASE_API}/projects`,
            {
                method: "POST",
                headers: headers(cloud),
                body: JSON.stringify({
                    name: cloud.remoteName,
                    db_pass: cloud.dbPassword,
                    organization_slug: cloud.account,
                    region: cloud.region
                })
            },
            projectSchema
        );
        return describe(request, cloud, body!.ref, body!.status);
    },
    async get(request: CloudFetch, cloud: CloudSecrets, id: string): Promise<CloudInstance> {
        const body = await providerCall(
            request,
            LABEL,
            `${SUPABASE_API}/projects/${encodeURIComponent(id)}`,
            { method: "GET", headers: headers(cloud) },
            projectSchema
        );
        return describe(request, cloud, body!.ref, body!.status);
    },
    async find(): Promise<string | null> {
        return null;
    },
    async remove(request: CloudFetch, cloud: CloudSecrets, id: string): Promise<void> {
        await providerCall(
            request,
            LABEL,
            `${SUPABASE_API}/projects/${encodeURIComponent(id)}`,
            { method: "DELETE", headers: headers(cloud) },
            z.unknown(),
            true
        );
    }
};
