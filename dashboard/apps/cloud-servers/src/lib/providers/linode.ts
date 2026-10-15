/**
 * Linode (Akamai) instances.
 *
 * API reference: https://techdocs.akamai.com/linode-api/reference/api
 *   GET  /v4/regions, /v4/linode/types, /v4/images
 *   POST /v4/linode/instances, GET/DELETE /v4/linode/instances/{id}
 *   POST /v4/linode/instances/{id}/{boot|shutdown|reboot|resize}
 * Types carry `price.hourly` and `price.monthly` in USD, with `region_prices`
 * overriding them in the regions that are priced differently. User data goes
 * in `metadata.user_data`, base64-encoded; a root password is required with an
 * image, so a throwaway one is sent and forgotten.
 */

import { z } from "zod";
import { throwawayPassword } from "../auth/throwaway";
import { bearer, callJson, callVoid, ProviderError } from "../http";
import {
    isLtsImage,
    type CloudMachine,
    type Credentials,
    type MachineStatus,
    type ProviderAdapter,
    type SizeChoice
} from "./types";

const API = "https://api.linode.com/v4";

const page = <T extends z.ZodTypeAny>(item: T) => z.object({ data: z.array(item).max(500) });
const priceSchema = z.object({ hourly: z.number().nullable(), monthly: z.number().nullable() });
const typeSchema = z.object({
    id: z.string(),
    label: z.string(),
    vcpus: z.number(),
    memory: z.number(),
    disk: z.number(),
    price: priceSchema,
    region_prices: z.array(priceSchema.extend({ id: z.string() })).default([])
});
const instanceSchema = z.object({
    id: z.number(),
    label: z.string(),
    status: z.string(),
    region: z.string(),
    type: z.string().nullable(),
    ipv4: z.array(z.string())
});

const STATUS: Readonly<Record<string, MachineStatus>> = {
    provisioning: "creating",
    running: "running",
    offline: "off",
    booting: "transitioning",
    rebooting: "transitioning",
    shutting_down: "transitioning",
    resizing: "transitioning",
    migrating: "transitioning",
    rebuilding: "transitioning",
    cloning: "transitioning",
    restoring: "transitioning",
    deleting: "transitioning",
    stopped: "off"
};

const PUBLIC_V4 = (ip: string) => !/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip);

function machine(i: z.infer<typeof instanceSchema>): CloudMachine {
    return {
        providerId: String(i.id),
        name: i.label,
        region: i.region,
        size: i.type ?? "",
        status: STATUS[i.status] ?? "unknown",
        ipv4: i.ipv4.find(PUBLIC_V4) ?? null
    };
}

function sizeChoice(t: z.infer<typeof typeSchema>, region: string): SizeChoice {
    const price = t.region_prices.find((p) => p.id === region) ?? t.price;
    return {
        id: t.id,
        label: `${t.label} (${t.vcpus} vCPU, ${t.memory / 1024} GB RAM, ${t.disk / 1024} GB)`,
        priceHourly: price.hourly,
        priceMonthly: price.monthly,
        currency: "USD"
    };
}

export function createAdapter(credentials: Credentials<"linode">): ProviderAdapter {
    const headers = bearer(credentials.token);
    const path = (id: string) => `${API}/linode/instances/${encodeURIComponent(id)}`;
    const post = (url: string, body: object = {}) =>
        callVoid(url, { method: "POST", headers, body: JSON.stringify(body) });
    const sizes = async (region: string) =>
        (
            await callJson(page(typeSchema), `${API}/linode/types?page_size=500`, { headers })
        ).data.map((t) => sizeChoice(t, region));

    return {
        async listRegions() {
            const { data } = await callJson(
                page(
                    z.object({
                        id: z.string(),
                        label: z.string(),
                        status: z.string(),
                        capabilities: z.array(z.string())
                    })
                ),
                `${API}/regions?page_size=500`,
                { headers }
            );
            // User data needs the Metadata service, which not every region has.
            return data
                .filter((r) => r.status === "ok" && r.capabilities.includes("Metadata"))
                .map((r) => ({ id: r.id, label: r.label }));
        },
        listSizes: sizes,
        async listImages() {
            const { data } = await callJson(
                page(
                    z.object({
                        id: z.string(),
                        label: z.string(),
                        is_public: z.boolean(),
                        deprecated: z.boolean(),
                        capabilities: z.array(z.string()).default([])
                    })
                ),
                `${API}/images?page_size=500`,
                { headers }
            );
            return data
                .filter(
                    (i) =>
                        i.is_public &&
                        !i.deprecated &&
                        i.capabilities.includes("cloud-init") &&
                        isLtsImage(i.label)
                )
                .map((i) => ({ id: i.id, label: i.label }));
        },
        async create(spec) {
            const answer = await callJson(instanceSchema, `${API}/linode/instances`, {
                method: "POST",
                headers,
                body: JSON.stringify({
                    label: spec.name,
                    region: spec.region,
                    type: spec.size,
                    image: spec.image,
                    root_pass: throwawayPassword(),
                    booted: true,
                    tags: ["polaris"],
                    metadata: { user_data: Buffer.from(spec.userData).toString("base64") }
                })
            });
            return machine(answer);
        },
        async get(ref) {
            try {
                return machine(await callJson(instanceSchema, path(ref.providerId), { headers }));
            } catch (caught) {
                if (caught instanceof ProviderError && caught.status === 404) return null;
                throw caught;
            }
        },
        async action(ref, action) {
            await post(
                `${path(ref.providerId)}/${action === "power_on" ? "boot" : action === "power_off" ? "shutdown" : "reboot"}`
            );
        },
        async resize(ref, size) {
            await post(`${path(ref.providerId)}/resize`, {
                type: size,
                allow_auto_disk_resize: false
            });
        },
        async destroy(ref) {
            await callVoid(path(ref.providerId), { method: "DELETE", headers });
        },
        async monthlyCost(region, size) {
            return (await sizes(region)).find((s) => s.id === size) ?? null;
        }
    };
}
