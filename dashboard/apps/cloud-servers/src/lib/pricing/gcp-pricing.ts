/**
 * A Compute Engine E2 machine type's on-demand price, from the Cloud Billing
 * Catalog API: the region's per-vCPU-hour and per-GiB-hour SKUs, times the
 * machine type's vCPUs and memory.
 *
 * API reference: https://docs.cloud.google.com/billing/docs/reference/rest/v1/services.skus/list
 *   GET https://cloudbilling.googleapis.com/v1/services/6F81-5844-456A/skus
 *   (6F81-5844-456A is Compute Engine), pages of up to 5000, OAuth scope
 *   https://www.googleapis.com/auth/cloud-billing.readonly.
 * Guide: https://docs.cloud.google.com/billing/v1/how-tos/catalog-api
 *   unitPrice is `units` plus `nanos` billionths, in `currencyCode`.
 *
 * Shared-core types (e2-micro, e2-small, e2-medium) are billed for a fraction
 * of a vCPU rather than the vCPUs they report, so they get no figure here
 * rather than a wrong one.
 */

import { z } from "zod";
import { callJson } from "../http";

export const COMPUTE_SERVICE = "services/6F81-5844-456A";
export const BILLING_SCOPE = "https://www.googleapis.com/auth/cloud-billing.readonly";
/** The most pages one read walks, so a catalogue that grows cannot run away. */
const MAX_PAGES = 20;

const moneySchema = z.object({
    currencyCode: z.string(),
    units: z.union([z.string(), z.number()]).optional(),
    nanos: z.number().optional()
});

export const skuSchema = z.object({
    description: z.string(),
    category: z.object({ resourceFamily: z.string(), resourceGroup: z.string(), usageType: z.string() }),
    serviceRegions: z.array(z.string()).default([]),
    pricingInfo: z
        .array(
            z.object({
                pricingExpression: z.object({
                    usageUnit: z.string(),
                    tieredRates: z.array(z.object({ unitPrice: moneySchema })).default([])
                })
            })
        )
        .default([])
});
export type Sku = z.infer<typeof skuSchema>;

export interface E2Rates {
    readonly core: number;
    readonly ramGiB: number;
    readonly currency: string;
}

function unitPrice(sku: Sku): { amount: number; currency: string } | null {
    const rates = sku.pricingInfo[0]?.pricingExpression.tieredRates ?? [];
    const last = rates[rates.length - 1]?.unitPrice;
    if (!last) return null;
    return { amount: Number(last.units ?? 0) + (last.nanos ?? 0) / 1e9, currency: last.currencyCode };
}

/** The E2 on-demand core and RAM rates of one region, or null. */
export function e2Rates(skus: readonly Sku[], region: string): E2Rates | null {
    const find = (group: "CPU" | "RAM", prefix: string, unit: string) =>
        skus.find(
            (s) =>
                s.category.resourceFamily === "Compute" &&
                s.category.usageType === "OnDemand" &&
                s.category.resourceGroup === group &&
                s.description.startsWith(prefix) &&
                s.serviceRegions.includes(region) &&
                s.pricingInfo[0]?.pricingExpression.usageUnit === unit
        );
    const core = find("CPU", "E2 Instance Core running in", "h");
    const ram = find("RAM", "E2 Instance Ram running in", "GiBy.h");
    const corePrice = core ? unitPrice(core) : null;
    const ramPrice = ram ? unitPrice(ram) : null;
    if (!corePrice || !ramPrice || corePrice.currency !== ramPrice.currency) return null;
    return { core: corePrice.amount, ramGiB: ramPrice.amount, currency: corePrice.currency };
}

/** The hourly price of a machine type from its region's rates. */
export function machineHourly(rates: E2Rates, vcpus: number, memoryMb: number): number {
    return Math.round((rates.core * vcpus + rates.ramGiB * (memoryMb / 1024)) * 1e6) / 1e6;
}

/** Every Compute Engine SKU, page by page, bounded. */
export async function computeSkus(token: string): Promise<Sku[]> {
    const skus: Sku[] = [];
    let pageToken = "";
    for (let page = 0; page < MAX_PAGES; page++) {
        const url = `https://cloudbilling.googleapis.com/v1/${COMPUTE_SERVICE}/skus?pageSize=5000${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ""}`;
        const answer = await callJson(
            z.object({ skus: z.array(skuSchema).default([]), nextPageToken: z.string().optional() }),
            url,
            { headers: { authorization: `Bearer ${token}` }, timeoutMs: 60_000 }
        );
        skus.push(...answer.skus);
        if (!answer.nextPageToken) break;
        pageToken = answer.nextPageToken;
    }
    return skus;
}
