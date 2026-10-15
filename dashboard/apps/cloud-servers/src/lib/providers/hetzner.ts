/**
 * Hetzner Cloud servers.
 *
 * API reference: https://docs.hetzner.cloud/
 *   GET  /v1/locations, /v1/server_types, /v1/images?type=system
 *   POST /v1/servers, GET/DELETE /v1/servers/{id}
 *   POST /v1/servers/{id}/actions/{poweron|poweroff|reboot|change_type}
 * Server types carry `prices[]` per location with `price_hourly.gross` and
 * `price_monthly.gross` (strings, EUR including VAT).
 */

import { z } from "zod";
import { bearer, callJson, callVoid, ProviderError } from "../http";
import { isLtsImage, type CloudMachine, type Credentials, type MachineStatus, type ProviderAdapter, type SizeChoice } from "./types";

const API = "https://api.hetzner.cloud/v1";

const locationsSchema = z.object({
    locations: z.array(z.object({ name: z.string(), description: z.string(), city: z.string() })).max(200)
});
const typeSchema = z.object({
    name: z.string(),
    cores: z.number(),
    memory: z.number(),
    disk: z.number(),
    deprecated: z.boolean().nullable().optional(),
    prices: z.array(
        z.object({
            location: z.string(),
            price_hourly: z.object({ gross: z.string() }),
            price_monthly: z.object({ gross: z.string() })
        })
    )
});
const typesSchema = z.object({ server_types: z.array(typeSchema).max(500) });
const imagesSchema = z.object({
    images: z.array(z.object({ name: z.string().nullable(), description: z.string(), architecture: z.string() })).max(500)
});
const serverSchema = z.object({
    id: z.number(),
    name: z.string(),
    status: z.string(),
    server_type: z.object({ name: z.string() }),
    datacenter: z.object({ location: z.object({ name: z.string() }) }),
    public_net: z.object({ ipv4: z.object({ ip: z.string() }).nullable() })
});

const STATUS: Readonly<Record<string, MachineStatus>> = {
    initializing: "creating",
    starting: "transitioning",
    running: "running",
    stopping: "transitioning",
    off: "off",
    deleting: "transitioning",
    rebuilding: "transitioning",
    migrating: "transitioning"
};

function machine(s: z.infer<typeof serverSchema>): CloudMachine {
    return {
        providerId: String(s.id),
        name: s.name,
        region: s.datacenter.location.name,
        size: s.server_type.name,
        status: STATUS[s.status] ?? "unknown",
        ipv4: s.public_net.ipv4?.ip ?? null
    };
}

function sizeChoice(t: z.infer<typeof typeSchema>, region: string): SizeChoice | null {
    const price = t.prices.find((p) => p.location === region);
    if (!price) return null;
    return {
        id: t.name,
        label: `${t.cores} vCPU, ${t.memory} GB RAM, ${t.disk} GB`,
        priceHourly: Number(price.price_hourly.gross),
        priceMonthly: Number(price.price_monthly.gross),
        currency: "EUR"
    };
}

export function createAdapter(credentials: Credentials<"hetzner">): ProviderAdapter {
    const headers = bearer(credentials.token);
    const serverPath = (id: string) => `${API}/servers/${encodeURIComponent(id)}`;
    const act = (id: string, verb: string, body: object = {}) =>
        callVoid(`${serverPath(id)}/actions/${verb}`, { method: "POST", headers, body: JSON.stringify(body) });
    const sizes = async (region: string) =>
        (await callJson(typesSchema, `${API}/server_types?per_page=50`, { headers })).server_types
            .filter((t) => !t.deprecated)
            .map((t) => sizeChoice(t, region))
            .filter((s): s is SizeChoice => s !== null);

    return {
        async listRegions() {
            const { locations } = await callJson(locationsSchema, `${API}/locations?per_page=50`, { headers });
            return locations.map((l) => ({ id: l.name, label: `${l.city} (${l.name})` }));
        },
        listSizes: sizes,
        async listImages() {
            const { images } = await callJson(imagesSchema, `${API}/images?type=system&status=available&per_page=50`, {
                headers
            });
            return images
                .filter((i) => i.name && i.architecture === "x86" && isLtsImage(i.description))
                .map((i) => ({ id: i.name!, label: i.description }));
        },
        async create(spec) {
            // No `ssh_keys`: Hetzner then mails a root password, which nobody
            // needs - Polaris reaches the machine through its enrollment login.
            const answer = await callJson(z.object({ server: serverSchema }), `${API}/servers`, {
                method: "POST",
                headers,
                body: JSON.stringify({
                    name: spec.name,
                    server_type: spec.size,
                    image: spec.image,
                    location: spec.region,
                    user_data: spec.userData,
                    labels: { polaris: "cloud-servers" }
                })
            });
            return machine(answer.server);
        },
        async get(ref) {
            try {
                return machine((await callJson(z.object({ server: serverSchema }), serverPath(ref.providerId), { headers })).server);
            } catch (caught) {
                if (caught instanceof ProviderError && caught.status === 404) return null;
                throw caught;
            }
        },
        async action(ref, action) {
            await act(ref.providerId, action === "power_on" ? "poweron" : action === "power_off" ? "poweroff" : "reboot");
        },
        async resize(ref, size) {
            // `upgrade_disk: false` keeps the disk, so a smaller type stays possible.
            await act(ref.providerId, "change_type", { server_type: size, upgrade_disk: false });
        },
        async destroy(ref) {
            await callVoid(serverPath(ref.providerId), { method: "DELETE", headers });
        },
        async monthlyCost(region, size) {
            return (await sizes(region)).find((s) => s.id === size) ?? null;
        }
    };
}
