/**
 * Microsoft Azure virtual machines, through Azure Resource Manager.
 *
 * Token: OAuth 2.0 client credentials against the tenant,
 *   https://learn.microsoft.com/entra/identity-platform/v2-oauth2-client-creds-grant-flow
 * Compute: https://learn.microsoft.com/rest/api/compute/virtual-machines
 *   PUT/GET/PATCH/DELETE .../virtualMachines/{name}, POST .../{start|powerOff|restart}
 *   GET .../providers/Microsoft.Compute/locations/{location}/vmSizes
 * Network: https://learn.microsoft.com/rest/api/virtualnetwork/
 * Resource groups: https://learn.microsoft.com/rest/api/resources/resource-groups
 * Images: the URNs listed in https://learn.microsoft.com/azure/virtual-machines/linux/cli-ps-findimage
 * and Canonical's https://discourse.ubuntu.com/t/find-ubuntu-images-on-azure/34259
 * Prices: the public Retail Prices API, https://learn.microsoft.com/rest/api/cost-management/retail-prices/azure-retail-prices
 *
 * Everything a machine needs lives in one resource group per location
 * (`polaris-cloud-servers-<location>`). The network interface, public address
 * and OS disk are created with the machine and set to be deleted with it.
 */

import { z } from "zod";
import { throwawaySshKey } from "../auth/throwaway";
import { callJson, callVoid, ProviderError } from "../http";
import type {
    CloudMachine,
    Credentials,
    MachineStatus,
    ProviderAdapter,
    SizeChoice
} from "./types";

const ARM = "https://management.azure.com";
const COMPUTE_API = "2024-07-01";
const NETWORK_API = "2024-05-01";
const RESOURCES_API = "2021-04-01";
const LOCATIONS_API = "2022-12-01";

/** Marketplace images, as `publisher:offer:sku`. */
const IMAGES: readonly { id: string; label: string }[] = [
    { id: "Canonical:ubuntu-24_04-lts:server", label: "Ubuntu 24.04 LTS" },
    { id: "Canonical:0001-com-ubuntu-server-jammy:22_04-lts-gen2", label: "Ubuntu 22.04 LTS" },
    { id: "Debian:debian-11:11-backports-gen2", label: "Debian 11" }
];

const tokenSchema = z.object({ access_token: z.string().min(1), expires_in: z.coerce.number() });
const vmSchema = z.object({
    name: z.string(),
    location: z.string(),
    properties: z.object({
        provisioningState: z.string(),
        hardwareProfile: z.object({ vmSize: z.string() }),
        instanceView: z.object({ statuses: z.array(z.object({ code: z.string() })) }).optional()
    })
});

export function vmStatus(vm: z.infer<typeof vmSchema>): MachineStatus {
    if (vm.properties.provisioningState === "Failed") return "failed";
    if (vm.properties.provisioningState === "Creating") return "creating";
    const power = vm.properties.instanceView?.statuses.find((s) =>
        s.code.startsWith("PowerState/")
    )?.code;
    if (power === "PowerState/running") return "running";
    if (power === "PowerState/stopped" || power === "PowerState/deallocated") return "off";
    if (power) return "transitioning";
    return "unknown";
}

export function createAdapter(credentials: Credentials<"azure">): ProviderAdapter {
    let token: { value: string; expiresAt: number } | null = null;
    const sub = `${ARM}/subscriptions/${credentials.subscriptionId}`;

    async function headers(): Promise<Record<string, string>> {
        if (!token || token.expiresAt < Date.now() + 60_000) {
            const answer = await callJson(
                tokenSchema,
                `https://login.microsoftonline.com/${credentials.tenantId}/oauth2/v2.0/token`,
                {
                    method: "POST",
                    headers: { "content-type": "application/x-www-form-urlencoded" },
                    body: new URLSearchParams({
                        grant_type: "client_credentials",
                        client_id: credentials.clientId,
                        client_secret: credentials.clientSecret,
                        scope: `${ARM}/.default`
                    }).toString()
                }
            );
            token = {
                value: answer.access_token,
                expiresAt: Date.now() + answer.expires_in * 1000
            };
        }
        return { authorization: `Bearer ${token.value}`, "content-type": "application/json" };
    }

    const group = (location: string) => {
        if (!/^[a-z0-9]{2,40}$/.test(location))
            throw new ProviderError("Unknown Azure location.", null);
        return `${sub}/resourceGroups/polaris-cloud-servers-${location}`;
    };
    const vmUrl = (location: string, name: string) =>
        `${group(location)}/providers/Microsoft.Compute/virtualMachines/${encodeURIComponent(name)}`;
    const put = async (url: string, body: object) =>
        callVoid(url, { method: "PUT", headers: await headers(), body: JSON.stringify(body) });

    async function ensureNetwork(location: string): Promise<{ subnet: string; nsg: string }> {
        await put(`${group(location)}?api-version=${RESOURCES_API}`, {
            location,
            tags: { polaris: "cloud-servers" }
        });
        const net = `${group(location)}/providers/Microsoft.Network`;
        const nsg = `${net}/networkSecurityGroups/polaris-ssh`;
        await put(`${nsg}?api-version=${NETWORK_API}`, {
            location,
            properties: {
                securityRules: [
                    {
                        name: "ssh",
                        properties: {
                            priority: 1000,
                            direction: "Inbound",
                            access: "Allow",
                            protocol: "Tcp",
                            sourceAddressPrefix: "*",
                            sourcePortRange: "*",
                            destinationAddressPrefix: "*",
                            destinationPortRange: "22"
                        }
                    }
                ]
            }
        });
        const vnet = `${net}/virtualNetworks/polaris-vnet`;
        await put(`${vnet}?api-version=${NETWORK_API}`, {
            location,
            properties: {
                addressSpace: { addressPrefixes: ["10.64.0.0/16"] },
                subnets: [{ name: "default", properties: { addressPrefix: "10.64.0.0/24" } }]
            }
        });
        return { subnet: `${vnet}/subnets/default`.slice(ARM.length), nsg: nsg.slice(ARM.length) };
    }

    async function readVm(location: string, name: string) {
        return callJson(
            vmSchema,
            `${vmUrl(location, name)}?$expand=instanceView&api-version=${COMPUTE_API}`,
            {
                headers: await headers()
            }
        );
    }

    async function publicIp(location: string, name: string): Promise<string | null> {
        try {
            const answer = await callJson(
                z.object({ properties: z.object({ ipAddress: z.string().optional() }) }),
                `${group(location)}/providers/Microsoft.Network/publicIPAddresses/${encodeURIComponent(`${name}-ip`)}?api-version=${NETWORK_API}`,
                { headers: await headers() }
            );
            return answer.properties.ipAddress ?? null;
        } catch {
            return null;
        }
    }

    async function price(location: string, size: string): Promise<SizeChoice | null> {
        if (!/^[a-z0-9]{2,40}$/.test(location) || !/^[A-Za-z0-9_]{2,64}$/.test(size)) return null;
        const filter = `serviceName eq 'Virtual Machines' and armRegionName eq '${location}' and armSkuName eq '${size}' and priceType eq 'Consumption'`;
        const answer = await callJson(
            z.object({
                Items: z
                    .array(
                        z.object({
                            retailPrice: z.number(),
                            unitOfMeasure: z.string(),
                            currencyCode: z.string(),
                            productName: z.string(),
                            skuName: z.string()
                        })
                    )
                    .max(200)
            }),
            `https://prices.azure.com/api/retail/prices?$filter=${encodeURIComponent(filter)}`
        );
        const linux = answer.Items.find(
            (i) =>
                i.unitOfMeasure === "1 Hour" &&
                !/windows/i.test(i.productName) &&
                !/spot|low priority/i.test(i.skuName)
        );
        return linux
            ? {
                  id: size,
                  label: size,
                  priceHourly: linux.retailPrice,
                  priceMonthly: null,
                  currency: linux.currencyCode
              }
            : null;
    }

    const ref = (providerId: string) => {
        const [location, name] = providerId.split("/");
        if (!location || !name) throw new ProviderError("Unknown Azure machine.", null);
        return { location, name };
    };

    return {
        async listRegions() {
            const answer = await callJson(
                z.object({
                    value: z
                        .array(
                            z.object({
                                name: z.string(),
                                displayName: z.string(),
                                metadata: z.object({ regionType: z.string().optional() }).optional()
                            })
                        )
                        .max(200)
                }),
                `${sub}/locations?api-version=${LOCATIONS_API}`,
                { headers: await headers() }
            );
            return answer.value
                .filter((l) => l.metadata?.regionType === "Physical")
                .map((l) => ({ id: l.name, label: l.displayName }));
        },
        async listSizes(region) {
            const answer = await callJson(
                z.object({
                    value: z
                        .array(
                            z.object({
                                name: z.string(),
                                numberOfCores: z.number(),
                                memoryInMB: z.number()
                            })
                        )
                        .max(2000)
                }),
                `${sub}/providers/Microsoft.Compute/locations/${encodeURIComponent(region)}/vmSizes?api-version=${COMPUTE_API}`,
                { headers: await headers() }
            );
            return answer.value
                .filter((s) => /^Standard_(B|D\d|E\d|F\d)/.test(s.name))
                .sort((a, b) => a.memoryInMB - b.memoryInMB)
                .map((s) => ({
                    id: s.name,
                    label: `${s.name} (${s.numberOfCores} vCPU, ${s.memoryInMB / 1024} GB RAM)`,
                    priceHourly: null,
                    priceMonthly: null,
                    currency: null
                }));
        },
        async listImages() {
            return IMAGES;
        },
        async create(spec) {
            const [publisher, offer, sku] = spec.image.split(":");
            if (!publisher || !offer || !sku) throw new ProviderError("Unknown Azure image.", null);
            const { subnet, nsg } = await ensureNetwork(spec.region);
            await put(`${vmUrl(spec.region, spec.name)}?api-version=${COMPUTE_API}`, {
                location: spec.region,
                tags: { polaris: "cloud-servers" },
                properties: {
                    hardwareProfile: { vmSize: spec.size },
                    storageProfile: {
                        imageReference: { publisher, offer, sku, version: "latest" },
                        osDisk: { createOption: "FromImage", deleteOption: "Delete" }
                    },
                    osProfile: {
                        computerName: spec.name,
                        adminUsername: "polarisadmin",
                        customData: Buffer.from(spec.userData).toString("base64"),
                        linuxConfiguration: {
                            disablePasswordAuthentication: true,
                            ssh: {
                                publicKeys: [
                                    {
                                        path: "/home/polarisadmin/.ssh/authorized_keys",
                                        keyData: throwawaySshKey()
                                    }
                                ]
                            }
                        }
                    },
                    networkProfile: {
                        networkApiVersion: "2020-11-01",
                        networkInterfaceConfigurations: [
                            {
                                name: `${spec.name}-nic`,
                                properties: {
                                    primary: true,
                                    deleteOption: "Delete",
                                    networkSecurityGroup: { id: nsg },
                                    ipConfigurations: [
                                        {
                                            name: "ipconfig",
                                            properties: {
                                                subnet: { id: subnet },
                                                publicIPAddressConfiguration: {
                                                    name: `${spec.name}-ip`,
                                                    sku: { name: "Standard" },
                                                    properties: {
                                                        deleteOption: "Delete",
                                                        publicIPAllocationMethod: "Static"
                                                    }
                                                }
                                            }
                                        }
                                    ]
                                }
                            }
                        ]
                    }
                }
            });
            return {
                providerId: `${spec.region}/${spec.name}`,
                name: spec.name,
                region: spec.region,
                size: spec.size,
                status: "creating",
                ipv4: null
            };
        },
        async get(machineRef) {
            const { location, name } = ref(machineRef.providerId);
            try {
                const vm = await readVm(location, name);
                const machine: CloudMachine = {
                    providerId: machineRef.providerId,
                    name: vm.name,
                    region: vm.location,
                    size: vm.properties.hardwareProfile.vmSize,
                    status: vmStatus(vm),
                    ipv4: await publicIp(location, name)
                };
                return machine;
            } catch (caught) {
                if (caught instanceof ProviderError && caught.status === 404) return null;
                throw caught;
            }
        },
        async action(machineRef, action) {
            const { location, name } = ref(machineRef.providerId);
            // Deallocate rather than power off: a powered-off machine is still billed.
            const verb =
                action === "power_on" ? "start" : action === "power_off" ? "deallocate" : "restart";
            await callVoid(`${vmUrl(location, name)}/${verb}?api-version=${COMPUTE_API}`, {
                method: "POST",
                headers: await headers()
            });
        },
        async resize(machineRef, size) {
            const { location, name } = ref(machineRef.providerId);
            await callVoid(`${vmUrl(location, name)}?api-version=${COMPUTE_API}`, {
                method: "PATCH",
                headers: await headers(),
                body: JSON.stringify({ properties: { hardwareProfile: { vmSize: size } } })
            });
        },
        async destroy(machineRef) {
            const { location, name } = ref(machineRef.providerId);
            await callVoid(`${vmUrl(location, name)}?api-version=${COMPUTE_API}`, {
                method: "DELETE",
                headers: await headers()
            });
        },
        monthlyCost: price
    };
}
