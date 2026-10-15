/**
 * Google Compute Engine instances, with a service account's key.
 *
 * API reference: https://cloud.google.com/compute/docs/reference/rest/v1
 *   GET  projects/{p}/zones, zones/{z}/machineTypes
 *   GET  projects/{ubuntu-os-cloud|debian-cloud}/global/images/family/{family}
 *   POST zones/{z}/instances, GET/DELETE zones/{z}/instances/{name}
 *   POST zones/{z}/instances/{name}/{start|stop|reset|setMachineType}
 * Image families: https://docs.cloud.google.com/compute/docs/images/os-details
 * The first-boot script is passed as the `startup-script` metadata key, which
 * Google's guest environment runs on every image:
 * https://cloud.google.com/compute/docs/instances/startup-scripts/linux
 *
 * Regions here are zones, where an instance actually lives. Prices come from
 * the Cloud Billing Catalog (see `pricing/gcp-pricing.ts`); the service account
 * needs the Cloud Billing API enabled on its project.
 */

import { z } from "zod";
import { callJson, callVoid, ProviderError } from "../http";
import { googleAccessToken, serviceAccountSchema } from "../auth/google-jwt";
import { BILLING_SCOPE, computeSkus, e2Rates, machineHourly } from "../pricing/gcp-pricing";
import type { CloudMachine, Credentials, MachineStatus, ProviderAdapter } from "./types";

const API = "https://compute.googleapis.com/compute/v1";

const FAMILIES: readonly { project: string; family: string; label: string }[] = [
    { project: "ubuntu-os-cloud", family: "ubuntu-2404-lts-amd64", label: "Ubuntu 24.04 LTS" },
    { project: "ubuntu-os-cloud", family: "ubuntu-2204-lts", label: "Ubuntu 22.04 LTS" },
    { project: "debian-cloud", family: "debian-12", label: "Debian 12" }
];

const STATUS: Readonly<Record<string, MachineStatus>> = {
    PROVISIONING: "creating",
    STAGING: "creating",
    RUNNING: "running",
    STOPPING: "transitioning",
    SUSPENDING: "transitioning",
    SUSPENDED: "off",
    TERMINATED: "off",
    REPAIRING: "transitioning"
};

const instanceSchema = z.object({
    name: z.string(),
    status: z.string(),
    zone: z.string(),
    machineType: z.string(),
    networkInterfaces: z
        .array(
            z.object({
                accessConfigs: z.array(z.object({ natIP: z.string().optional() })).optional()
            })
        )
        .default([])
});

const last = (url: string) => url.slice(url.lastIndexOf("/") + 1);

export function machineOf(i: z.infer<typeof instanceSchema>): CloudMachine {
    return {
        providerId: i.name,
        name: i.name,
        region: last(i.zone),
        size: last(i.machineType),
        status: STATUS[i.status] ?? "unknown",
        ipv4: i.networkInterfaces[0]?.accessConfigs?.[0]?.natIP ?? null
    };
}

/** The service account inside the stored credential, validated. */
export function readServiceAccount(json: string) {
    let raw: unknown;
    try {
        raw = JSON.parse(json);
    } catch {
        throw new ProviderError("The service account key is not valid JSON.", null);
    }
    const parsed = serviceAccountSchema.safeParse(raw);
    if (!parsed.success) throw new ProviderError("The file is not a service account key.", null);
    return parsed.data;
}

export function createAdapter(credentials: Credentials<"gcp">): ProviderAdapter {
    const account = readServiceAccount(credentials.serviceAccountJson);
    const project = `${API}/projects/${encodeURIComponent(account.project_id)}`;
    let token: { token: string; expiresAt: number } | null = null;

    async function headers(): Promise<Record<string, string>> {
        if (!token || token.expiresAt < Date.now() + 60_000)
            token = await googleAccessToken(account);
        return { authorization: `Bearer ${token.token}`, "content-type": "application/json" };
    }

    const zone = (z: string) => {
        if (!/^[a-z]+-[a-z]+\d+-[a-z]$/.test(z))
            throw new ProviderError("Unknown Compute Engine zone.", null);
        return `${project}/zones/${z}`;
    };
    const instance = (ref: { providerId: string; region: string }) =>
        `${zone(ref.region)}/instances/${encodeURIComponent(ref.providerId)}`;
    const post = async (url: string, body: object = {}) =>
        callVoid(url, { method: "POST", headers: await headers(), body: JSON.stringify(body) });

    return {
        async listRegions() {
            const answer = await callJson(
                z.object({
                    items: z.array(z.object({ name: z.string(), status: z.string() })).max(500)
                }),
                `${project}/zones?maxResults=500`,
                { headers: await headers() }
            );
            return answer.items
                .filter((z) => z.status === "UP")
                .map((z) => ({ id: z.name, label: z.name }));
        },
        async listSizes(region) {
            const answer = await callJson(
                z.object({
                    items: z
                        .array(
                            z.object({
                                name: z.string(),
                                guestCpus: z.number(),
                                memoryMb: z.number(),
                                description: z.string()
                            })
                        )
                        .max(2000)
                        .default([])
                }),
                `${zone(region)}/machineTypes?maxResults=500&filter=${encodeURIComponent('name = "e2-*"')}`,
                { headers: await headers() }
            );
            return answer.items
                .sort((a, b) => a.memoryMb - b.memoryMb)
                .map((m) => ({
                    id: m.name,
                    label: `${m.name} (${m.description})`,
                    priceHourly: null,
                    priceMonthly: null,
                    currency: null
                }));
        },
        async listImages() {
            const found = await Promise.all(
                FAMILIES.map(async (f) => {
                    const image = await callJson(
                        z.object({ selfLink: z.string().url() }),
                        `${API}/projects/${f.project}/global/images/family/${f.family}`,
                        { headers: await headers() }
                    ).catch(() => null);
                    return image
                        ? {
                              id: `projects/${f.project}/global/images/family/${f.family}`,
                              label: f.label
                          }
                        : null;
                })
            );
            return found.filter((i): i is { id: string; label: string } => i !== null);
        },
        async create(spec) {
            if (
                !/^projects\/(ubuntu-os-cloud|debian-cloud)\/global\/images\/family\/[a-z0-9-]+$/.test(
                    spec.image
                )
            ) {
                throw new ProviderError("Unknown Compute Engine image.", null);
            }
            await post(`${zone(spec.region)}/instances`, {
                name: spec.name,
                machineType: `zones/${spec.region}/machineTypes/${spec.size}`,
                labels: { polaris: "cloud-servers" },
                disks: [
                    { boot: true, autoDelete: true, initializeParams: { sourceImage: spec.image } }
                ],
                networkInterfaces: [
                    {
                        network: "global/networks/default",
                        accessConfigs: [{ type: "ONE_TO_ONE_NAT", name: "External NAT" }]
                    }
                ],
                metadata: { items: [{ key: "startup-script", value: spec.userData }] }
            });
            return {
                providerId: spec.name,
                name: spec.name,
                region: spec.region,
                size: spec.size,
                status: "creating",
                ipv4: null
            };
        },
        async get(ref) {
            try {
                return machineOf(
                    await callJson(instanceSchema, instance(ref), { headers: await headers() })
                );
            } catch (caught) {
                if (caught instanceof ProviderError && caught.status === 404) return null;
                throw caught;
            }
        },
        async action(ref, action) {
            await post(
                `${instance(ref)}/${action === "power_on" ? "start" : action === "power_off" ? "stop" : "reset"}`
            );
        },
        async resize(ref, size) {
            await post(`${instance(ref)}/setMachineType`, {
                machineType: `zones/${ref.region}/machineTypes/${size}`
            });
        },
        async destroy(ref) {
            await callVoid(instance(ref), { method: "DELETE", headers: await headers() });
        },
        async monthlyCost(region, size) {
            const type = await callJson(
                z.object({
                    guestCpus: z.number(),
                    memoryMb: z.number(),
                    isSharedCpu: z.boolean().optional()
                }),
                `${zone(region)}/machineTypes/${encodeURIComponent(size)}`,
                { headers: await headers() }
            );
            if (type.isSharedCpu || !size.startsWith("e2-")) return null;
            const billing = await googleAccessToken(account, BILLING_SCOPE);
            const rates = e2Rates(await computeSkus(billing.token), region.replace(/-[a-z]$/, ""));
            if (!rates) return null;
            return {
                id: size,
                label: size,
                priceHourly: machineHourly(rates, type.guestCpus, type.memoryMb),
                priceMonthly: null,
                currency: rates.currency
            };
        }
    };
}
