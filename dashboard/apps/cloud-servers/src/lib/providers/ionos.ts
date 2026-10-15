/**
 * IONOS Cloud servers, through Cloud API v6.
 *
 * API reference: https://api.ionos.com/docs/cloud/v6/
 *   GET  /locations?depth=1 (each location lists its `imageAliases`)
 *   GET/POST /datacenters, POST /datacenters/{dc}/lans
 *   POST /datacenters/{dc}/servers (with volumes and nics as entities)
 *   GET/PATCH/DELETE /datacenters/{dc}/servers/{id}
 *   POST /datacenters/{dc}/servers/{id}/{start|stop|reboot}
 *   DELETE /datacenters/{dc}/volumes/{id}
 * Authentication: a token as `Authorization: Bearer`.
 * Volume fields (type enum, size in GB, imageAlias, sshKeys, base64 userData for
 * cloud-init images): https://github.com/ionos-cloud/sdk-go/blob/master/docs/models/VolumeProperties.md
 *
 * IONOS servers have no fixed sizes: cores and memory are chosen freely, so the
 * sizes offered are a short list of combinations. IONOS publishes no price API,
 * so cost is reported as not available.
 *
 * One data center per location (`polaris-cloud-servers-<location>`) with one
 * public LAN holds every machine. A server's id here is `<datacenter>/<server>`.
 */

import { z } from "zod";
import { throwawaySshKey } from "../auth/throwaway";
import { bearer, callJson, callVoid, ProviderError } from "../http";
import type { CloudMachine, Credentials, MachineStatus, ProviderAdapter, SizeChoice } from "./types";

const API = "https://api.ionos.com/cloudapi/v6";

/** Cores and memory (GB), offered as sizes. */
const SIZES: readonly [number, number][] = [
    [1, 2],
    [2, 4],
    [4, 8],
    [8, 16],
    [16, 32]
];

const locationSchema = z.object({
    id: z.string(),
    properties: z.object({ name: z.string(), imageAliases: z.array(z.string()).default([]) })
});
const serverSchema = z.object({
    id: z.string(),
    metadata: z.object({ state: z.string() }),
    properties: z.object({ name: z.string(), cores: z.number(), ram: z.number(), vmState: z.string().optional() }),
    entities: z
        .object({
            nics: z
                .object({ items: z.array(z.object({ properties: z.object({ ips: z.array(z.string()).default([]) }) })).default([]) })
                .optional(),
            volumes: z.object({ items: z.array(z.object({ id: z.string() })).default([]) }).optional()
        })
        .optional()
});

export function ionosStatus(s: z.infer<typeof serverSchema>): MachineStatus {
    if (s.metadata.state === "BUSY") return "transitioning";
    if (s.metadata.state === "FAILED") return "failed";
    if (s.properties.vmState === "RUNNING") return "running";
    if (s.properties.vmState === "SHUTOFF" || s.properties.vmState === "SHUTDOWN") return "off";
    return "unknown";
}

export function sizeId(cores: number, ramGb: number): string {
    return `${cores}c-${ramGb}gb`;
}

function parseSize(id: string): { cores: number; ram: number } {
    const match = /^(\d+)c-(\d+)gb$/.exec(id);
    if (!match) throw new ProviderError("Unknown IONOS size.", null);
    return { cores: Number(match[1]), ram: Number(match[2]) * 1024 };
}

export function createAdapter(credentials: Credentials<"ionos">): ProviderAdapter {
    const headers = bearer(credentials.token);
    const split = (providerId: string) => {
        const [dc, server] = providerId.split("/");
        if (!dc || !server) throw new ProviderError("Unknown IONOS server.", null);
        return { dc, server, url: `${API}/datacenters/${encodeURIComponent(dc)}/servers/${encodeURIComponent(server)}` };
    };

    async function readServer(providerId: string, location: string): Promise<CloudMachine> {
        const { url } = split(providerId);
        const s = await callJson(serverSchema, `${url}?depth=3`, { headers });
        return {
            providerId,
            name: s.properties.name,
            region: location,
            size: sizeId(s.properties.cores, s.properties.ram / 1024),
            status: ionosStatus(s),
            ipv4: s.entities?.nics?.items.flatMap((n) => n.properties.ips)[0] ?? null
        };
    }

    async function datacenter(location: string): Promise<{ dc: string; lan: string }> {
        const name = `polaris-cloud-servers-${location.replace("/", "-")}`;
        const list = await callJson(
            z.object({ items: z.array(z.object({ id: z.string(), properties: z.object({ name: z.string(), location: z.string() }) })).max(1000) }),
            `${API}/datacenters?depth=1`,
            { headers }
        );
        let dc = list.items.find((d) => d.properties.name === name && d.properties.location === location)?.id;
        if (!dc) {
            dc = (
                await callJson(z.object({ id: z.string() }), `${API}/datacenters`, {
                    method: "POST",
                    headers,
                    body: JSON.stringify({ properties: { name, location } })
                })
            ).id;
        }
        const lans = await callJson(
            z.object({ items: z.array(z.object({ id: z.string(), properties: z.object({ public: z.boolean() }) })).max(100) }),
            `${API}/datacenters/${dc}/lans?depth=1`,
            { headers }
        );
        let lan = lans.items.find((l) => l.properties.public)?.id;
        if (!lan) {
            lan = (
                await callJson(z.object({ id: z.string() }), `${API}/datacenters/${dc}/lans`, {
                    method: "POST",
                    headers,
                    body: JSON.stringify({ properties: { name: "polaris-public", public: true } })
                })
            ).id;
        }
        return { dc, lan };
    }

    const sizes = (): SizeChoice[] =>
        SIZES.map(([cores, ram]) => ({
            id: sizeId(cores, ram),
            label: `${cores} vCPU, ${ram} GB RAM`,
            priceHourly: null,
            priceMonthly: null,
            currency: null
        }));

    return {
        async listRegions() {
            const answer = await callJson(z.object({ items: z.array(locationSchema).max(100) }), `${API}/locations?depth=1`, { headers });
            return answer.items.map((l) => ({ id: l.id, label: `${l.properties.name} (${l.id})` }));
        },
        async listSizes() {
            return sizes();
        },
        async listImages(region) {
            const location = await callJson(locationSchema, `${API}/locations/${region.split("/").map(encodeURIComponent).join("/")}`, {
                headers
            });
            return location.properties.imageAliases
                .filter((a) => /^(ubuntu|debian):/.test(a) && !a.endsWith("_iso"))
                .map((a) => ({ id: a, label: a }));
        },
        async create(spec) {
            const { cores, ram } = parseSize(spec.size);
            const { dc, lan } = await datacenter(spec.region);
            const created = await callJson(z.object({ id: z.string() }), `${API}/datacenters/${dc}/servers`, {
                method: "POST",
                headers,
                body: JSON.stringify({
                    properties: { name: spec.name, cores, ram },
                    entities: {
                        volumes: {
                            items: [
                                {
                                    properties: {
                                        name: `${spec.name}-disk`,
                                        size: 20,
                                        type: "SSD Standard",
                                        imageAlias: spec.image,
                                        // Public Linux images take keys; Polaris never uses this one.
                                        sshKeys: [throwawaySshKey()],
                                        userData: Buffer.from(spec.userData).toString("base64")
                                    }
                                }
                            ]
                        },
                        nics: { items: [{ properties: { name: "public", lan: Number(lan), dhcp: true } }] }
                    }
                })
            });
            return {
                providerId: `${dc}/${created.id}`,
                name: spec.name,
                region: spec.region,
                size: spec.size,
                status: "creating",
                ipv4: null
            };
        },
        async get(ref) {
            try {
                return await readServer(ref.providerId, ref.region);
            } catch (caught) {
                if (caught instanceof ProviderError && caught.status === 404) return null;
                throw caught;
            }
        },
        async action(ref, action) {
            const { url } = split(ref.providerId);
            await callVoid(`${url}/${action === "power_on" ? "start" : action === "power_off" ? "stop" : "reboot"}`, {
                method: "POST",
                headers
            });
        },
        async resize(ref, size) {
            const { url } = split(ref.providerId);
            await callVoid(url, { method: "PATCH", headers, body: JSON.stringify(parseSize(size)) });
        },
        async destroy(ref) {
            const { dc, url } = split(ref.providerId);
            // A server's volumes outlive it unless removed; read them first.
            const server = await callJson(serverSchema, `${url}?depth=2`, { headers });
            await callVoid(url, { method: "DELETE", headers });
            let kept = 0;
            for (const volume of server.entities?.volumes?.items ?? []) {
                await callVoid(`${API}/datacenters/${encodeURIComponent(dc)}/volumes/${encodeURIComponent(volume.id)}`, {
                    method: "DELETE",
                    headers
                }).catch(() => kept++);
            }
            // A disk left behind is still billed, so it is said rather than swallowed.
            if (kept > 0) throw new ProviderError("The server was removed but IONOS kept its disk; delete the disk at IONOS.", null);
        },
        async monthlyCost() {
            return null;
        }
    };
}
