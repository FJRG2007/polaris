/**
 * Vultr cloud compute instances.
 *
 * API reference: https://www.vultr.com/api/
 *   GET  /v2/regions, /v2/plans?type=vc2, /v2/os
 *   POST /v2/instances, GET/PATCH/DELETE /v2/instances/{id}
 *   POST /v2/instances/{id}/{start|halt|reboot}
 * Plans carry `monthly_cost` in USD and the regions they are sold in. Vultr
 * publishes no hourly figure here, so only the monthly one is used.
 * `user_data` is sent base64-encoded, as the API requires.
 */

import { z } from "zod";
import { bearer, callJson, callVoid, ProviderError } from "../http";
import { isLtsImage, type CloudMachine, type Credentials, type MachineStatus, type ProviderAdapter, type SizeChoice } from "./types";

const API = "https://api.vultr.com/v2";

const regionsSchema = z.object({
    regions: z.array(z.object({ id: z.string(), city: z.string(), country: z.string() })).max(200)
});
const planSchema = z.object({
    id: z.string(),
    vcpu_count: z.number(),
    ram: z.number(),
    disk: z.number(),
    monthly_cost: z.number(),
    locations: z.array(z.string())
});
const plansSchema = z.object({ plans: z.array(planSchema).max(1000) });
const osSchema = z.object({
    os: z.array(z.object({ id: z.number(), name: z.string(), arch: z.string(), family: z.string() })).max(1000)
});
const instanceSchema = z.object({
    id: z.string(),
    label: z.string(),
    main_ip: z.string(),
    status: z.string(),
    power_status: z.string(),
    region: z.string(),
    plan: z.string()
});

function status(i: z.infer<typeof instanceSchema>): MachineStatus {
    if (i.status === "pending") return "creating";
    if (i.status === "suspended" || i.status === "resizing") return "transitioning";
    return i.power_status === "running" ? "running" : i.power_status === "stopped" ? "off" : "unknown";
}

function machine(i: z.infer<typeof instanceSchema>): CloudMachine {
    return {
        providerId: i.id,
        name: i.label,
        region: i.region,
        size: i.plan,
        status: status(i),
        ipv4: i.main_ip && i.main_ip !== "0.0.0.0" ? i.main_ip : null
    };
}

function sizeChoice(p: z.infer<typeof planSchema>): SizeChoice {
    return {
        id: p.id,
        label: `${p.vcpu_count} vCPU, ${p.ram / 1024} GB RAM, ${p.disk} GB`,
        priceHourly: null,
        priceMonthly: p.monthly_cost,
        currency: "USD"
    };
}

export function createAdapter(credentials: Credentials<"vultr">): ProviderAdapter {
    const headers = bearer(credentials.token);
    const path = (id: string) => `${API}/instances/${encodeURIComponent(id)}`;
    const sizes = async (region: string) =>
        (await callJson(plansSchema, `${API}/plans?type=vc2&per_page=500`, { headers })).plans
            .filter((p) => p.locations.includes(region))
            .map(sizeChoice);

    return {
        async listRegions() {
            const { regions } = await callJson(regionsSchema, `${API}/regions?per_page=500`, { headers });
            return regions.map((r) => ({ id: r.id, label: `${r.city}, ${r.country}` }));
        },
        listSizes: sizes,
        async listImages() {
            const { os } = await callJson(osSchema, `${API}/os?per_page=500`, { headers });
            return os
                .filter((o) => o.arch === "x64" && isLtsImage(o.name))
                .map((o) => ({ id: String(o.id), label: o.name }));
        },
        async create(spec) {
            const answer = await callJson(z.object({ instance: instanceSchema }), `${API}/instances`, {
                method: "POST",
                headers,
                body: JSON.stringify({
                    region: spec.region,
                    plan: spec.size,
                    os_id: Number(spec.image),
                    label: spec.name,
                    hostname: spec.name,
                    user_data: Buffer.from(spec.userData).toString("base64"),
                    tags: ["polaris"]
                })
            });
            return machine(answer.instance);
        },
        async get(ref) {
            try {
                return machine((await callJson(z.object({ instance: instanceSchema }), path(ref.providerId), { headers })).instance);
            } catch (caught) {
                if (caught instanceof ProviderError && caught.status === 404) return null;
                throw caught;
            }
        },
        async action(ref, action) {
            const verb = action === "power_on" ? "start" : action === "power_off" ? "halt" : "reboot";
            await callVoid(`${path(ref.providerId)}/${verb}`, { method: "POST", headers, body: "{}" });
        },
        async resize(ref, size) {
            await callVoid(path(ref.providerId), { method: "PATCH", headers, body: JSON.stringify({ plan: size }) });
        },
        async destroy(ref) {
            await callVoid(path(ref.providerId), { method: "DELETE", headers });
        },
        async monthlyCost(region, size) {
            return (await sizes(region)).find((s) => s.id === size) ?? null;
        }
    };
}
