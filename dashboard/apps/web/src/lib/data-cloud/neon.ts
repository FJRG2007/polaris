/**
 * PostgreSQL at Neon, with the user's own API key.
 *
 * Neon API v2, as documented:
 * - https://neon.com/docs/reference/api/projects/create-project -
 *   `POST https://console.neon.tech/api/v2/projects` with `project.name`,
 *   `project.region_id` and `project.org_id`; answers with `project` and
 *   `connection_uris[].connection_uri`.
 * - https://neon.com/docs/reference/api/projects/get-project
 * - https://neon.com/docs/reference/api/projects/delete-project
 *
 * A project takes connections as soon as the create answers, and the answer is
 * the only place the connection URI is given: the documented read of a project
 * does not carry one. Listing projects by name is not on the pages above, so a
 * create whose answer was lost cannot be found again; `find` says so.
 */

import { z } from "zod";
import * as core from "@polaris/core";
import type { CloudFetch } from "./cloudamqp";
import { providerCall, type CloudCreator, type CloudInstance, type CloudSecrets } from "./managed";

export const NEON_API = "https://console.neon.tech/api/v2";
const LABEL = "Neon";

const created = z.object({
    project: z.object({ id: z.string().min(1) }),
    connection_uris: z.array(z.object({ connection_uri: z.string().min(1) })).min(1)
});
const project = z.object({ project: z.object({ id: z.string().min(1) }) });

function headers(cloud: CloudSecrets): Record<string, string> {
    return {
        authorization: `Bearer ${cloud.apiKey ?? ""}`,
        accept: "application/json",
        "content-type": "application/json"
    };
}

/** The endpoint of a PostgreSQL connection string, as a connected one is read. */
export function postgresEndpoint(url: string): core.DataEndpoint {
    return core.cloudEndpoint(
        core.cloudConnectSchema.parse({
            environmentId: "00000000-0000-4000-8000-000000000000",
            name: "cloud",
            engine: "postgres",
            provider: "other",
            url
        })
    );
}

export const neon: CloudCreator = {
    label: LABEL,
    async create(request: CloudFetch, cloud: CloudSecrets): Promise<CloudInstance> {
        const body = await providerCall(
            request,
            LABEL,
            `${NEON_API}/projects`,
            {
                method: "POST",
                headers: headers(cloud),
                body: JSON.stringify({
                    project: {
                        name: cloud.remoteName,
                        region_id: cloud.region,
                        ...(cloud.account ? { org_id: cloud.account } : {})
                    }
                })
            },
            created
        );
        return {
            id: body!.project.id,
            ready: true,
            endpoint: postgresEndpoint(body!.connection_uris[0]!.connection_uri)
        };
    },
    async get(request: CloudFetch, cloud: CloudSecrets, id: string): Promise<CloudInstance> {
        // Only proof the project is there: its address came with the create.
        const body = await providerCall(
            request,
            LABEL,
            `${NEON_API}/projects/${encodeURIComponent(id)}`,
            { method: "GET", headers: headers(cloud) },
            project
        );
        return { id: body!.project.id, ready: false, endpoint: null };
    },
    async find(): Promise<string | null> {
        return null;
    },
    async remove(request: CloudFetch, cloud: CloudSecrets, id: string): Promise<void> {
        await providerCall(
            request,
            LABEL,
            `${NEON_API}/projects/${encodeURIComponent(id)}`,
            { method: "DELETE", headers: headers(cloud) },
            z.unknown(),
            true
        );
    }
};
