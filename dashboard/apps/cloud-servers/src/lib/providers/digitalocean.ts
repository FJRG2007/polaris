/**
 * DigitalOcean Droplets.
 *
 * API reference: https://docs.digitalocean.com/reference/api/digitalocean/
 *   GET  /v2/regions, /v2/sizes, /v2/images?type=distribution
 *   POST /v2/droplets, GET/DELETE /v2/droplets/{id}
 *   POST /v2/droplets/{id}/actions  (power_on, power_off, reboot, resize)
 * Sizes carry `price_hourly` and `price_monthly` in USD.
 */

import { z } from "zod";
import { bearer, callJson, callVoid } from "../http";
import { isLtsImage, type CloudMachine, type Credentials, type MachineStatus, type ProviderAdapter, type SizeChoice } from "./types";

const API = "https://api.digitalocean.com/v2";
const PAGE = "per_page=200";

const regionsSchema = z.object({
    regions: z.array(z.object({ slug: z.string(), name: z.string(), available: z.boolean() })).max(500)
});
const sizeSchema = z.object({
    slug: z.string(),
    memory: z.number(),
    vcpus: z.number(),
    disk: z.number(),
    price_monthly: z.number(),
    price_hourly: z.number(),
    regions: z.array(z.string()),
    available: z.boolean()
});
const sizesSchema = z.object({ sizes: z.array(sizeSchema).max(1000) });
const imagesSchema = z.object({
    images: z.array(z.object({ slug: z.string().nullable(), name: z.string(), distribution: z.string() })).max(1000)
});
const dropletSchema = z.object({
    id: z.number(),
    name: z.string(),
    status: z.string(),
    size_slug: z.string(),
    region: z.object({ slug: z.string() }),
    networks: z.object({ v4: z.array(z.object({ ip_address: z.string(), type: z.string() })) })
});

const STATUS: Readonly<Record<string, MachineStatus>> = { new: "creating", active: "running", off: "off", archive: "off" };

function machine(d: z.infer<typeof dropletSchema>): CloudMachine {
    return {
        providerId: String(d.id),
        name: d.name,
        region: d.region.slug,
        size: d.size_slug,
        status: STATUS[d.status] ?? "unknown",
        ipv4: d.networks.v4.find((n) => n.type === "public")?.ip_address ?? null
    };
}

function sizeChoice(s: z.infer<typeof sizeSchema>): SizeChoice {
    return {
        id: s.slug,
        label: `${s.vcpus} vCPU, ${s.memory / 1024} GB RAM, ${s.disk} GB`,
        priceHourly: s.price_hourly,
        priceMonthly: s.price_monthly,
        currency: "USD"
    };
}

export function createAdapter(credentials: Credentials<"digitalocean">): ProviderAdapter {
    const headers = bearer(credentials.token);
    const sizes = async (region: string) =>
        (await callJson(sizesSchema, `${API}/sizes?${PAGE}`, { headers })).sizes.filter(
            (s) => s.available && s.regions.includes(region)
        );
    const dropletPath = (id: string) => `${API}/droplets/${encodeURIComponent(id)}`;
    const act = (id: string, body: object) =>
        callVoid(`${dropletPath(id)}/actions`, { method: "POST", headers, body: JSON.stringify(body) });

    return {
        async listRegions() {
            const { regions } = await callJson(regionsSchema, `${API}/regions?${PAGE}`, { headers });
            return regions.filter((r) => r.available).map((r) => ({ id: r.slug, label: r.name }));
        },
        async listSizes(region) {
            return (await sizes(region)).map(sizeChoice);
        },
        async listImages() {
            const { images } = await callJson(imagesSchema, `${API}/images?type=distribution&${PAGE}`, { headers });
            return images
                .filter((i) => i.slug && isLtsImage(`${i.distribution} ${i.name}`))
                .map((i) => ({ id: i.slug!, label: `${i.distribution} ${i.name}` }));
        },
        async create(spec) {
            const answer = await callJson(z.object({ droplet: dropletSchema }), `${API}/droplets`, {
                method: "POST",
                headers,
                body: JSON.stringify({
                    name: spec.name,
                    region: spec.region,
                    size: spec.size,
                    image: spec.image,
                    user_data: spec.userData,
                    tags: ["polaris"]
                })
            });
            return machine(answer.droplet);
        },
        async get(ref) {
            try {
                return machine((await callJson(z.object({ droplet: dropletSchema }), dropletPath(ref.providerId), { headers })).droplet);
            } catch (caught) {
                if ((caught as { status?: number }).status === 404) return null;
                throw caught;
            }
        },
        async action(ref, action) {
            await act(ref.providerId, { type: action });
        },
        async resize(ref, size) {
            // `disk: false` keeps the disk, so the resize can be undone.
            await act(ref.providerId, { type: "resize", size, disk: false });
        },
        async destroy(ref) {
            await callVoid(dropletPath(ref.providerId), { method: "DELETE", headers });
        },
        async monthlyCost(region, size) {
            const found = (await sizes(region)).find((s) => s.slug === size);
            return found ? sizeChoice(found) : null;
        }
    };
}
