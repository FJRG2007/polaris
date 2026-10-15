/**
 * Prices read from AWS's Price List Query API and Google's Cloud Billing
 * Catalog: the request each builds and how each answer becomes an hourly
 * figure. Answers are fixtures shaped like the documented responses; no real
 * provider is called.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { priceFresh, PRICE_TTL_MS } from "@polaris-app/cloud-servers/src/lib/service";
import {
    e2Rates,
    machineHourly,
    type Sku
} from "@polaris-app/cloud-servers/src/lib/pricing/gcp-pricing";
import {
    awsHourlyPrice,
    priceFilters,
    readHourlyUsd
} from "@polaris-app/cloud-servers/src/lib/pricing/aws-pricing";

afterEach(() => vi.unstubAllGlobals());

function awsProduct(operation: string, usd: string, unit = "Hrs"): string {
    return JSON.stringify({
        product: {
            productFamily: "Compute Instance",
            attributes: { instanceType: "t3.micro", operation },
            sku: "FIXTURESKU"
        },
        serviceCode: "AmazonEC2",
        terms: {
            OnDemand: {
                "FIXTURESKU.JRTCKXETXF": {
                    priceDimensions: {
                        "FIXTURESKU.JRTCKXETXF.6YS6EN2CT7": { unit, pricePerUnit: { USD: usd } }
                    }
                }
            }
        }
    });
}

describe("AWS price list", () => {
    it("filters to exactly the plain on-demand Linux product", () => {
        expect(priceFilters("t3.micro", "eu-west-1")).toEqual([
            { Type: "TERM_MATCH", Field: "instanceType", Value: "t3.micro" },
            { Type: "TERM_MATCH", Field: "regionCode", Value: "eu-west-1" },
            { Type: "TERM_MATCH", Field: "operatingSystem", Value: "Linux" },
            { Type: "TERM_MATCH", Field: "tenancy", Value: "Shared" },
            { Type: "TERM_MATCH", Field: "preInstalledSw", Value: "NA" },
            { Type: "TERM_MATCH", Field: "capacitystatus", Value: "Used" }
        ]);
    });

    it("prefers RunInstances over a licensed operation and ignores non-hourly units", () => {
        expect(
            readHourlyUsd([
                awsProduct("RunInstances:0010", "0.05"),
                awsProduct("RunInstances", "0.0114")
            ])
        ).toBe(0.0114);
        expect(readHourlyUsd([awsProduct("RunInstances", "0.1", "GB-Mo")])).toBeNull();
        expect(readHourlyUsd([])).toBeNull();
    });

    it("signs a GetProducts call for the pricing service in us-east-1", async () => {
        const calls: { url: string; init: RequestInit }[] = [];
        vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
            calls.push({ url, init });
            return new Response(
                JSON.stringify({
                    FormatVersion: "aws_v1",
                    PriceList: [awsProduct("RunInstances", "0.0114")]
                })
            );
        });
        const price = await awsHourlyPrice(
            { accessKeyId: "AKIDEXAMPLEFIXTURE", secretAccessKey: "fixture/secret" },
            "t3.micro",
            "eu-west-1"
        );
        expect(price).toBe(0.0114);
        const headers = calls[0]!.init.headers as Record<string, string>;
        expect(calls[0]!.url).toBe("https://api.pricing.us-east-1.amazonaws.com/");
        expect(headers["x-amz-target"]).toBe("AWSPriceListService.GetProducts");
        expect(headers["content-type"]).toBe("application/x-amz-json-1.1");
        expect(headers.authorization).toMatch(
            /\/us-east-1\/pricing\/aws4_request, SignedHeaders=content-type;host;x-amz-date;x-amz-target, /
        );
        expect(JSON.parse(calls[0]!.init.body as string)).toMatchObject({
            ServiceCode: "AmazonEC2",
            FormatVersion: "aws_v1"
        });
    });
});

function sku(
    description: string,
    group: string,
    unit: string,
    units: string,
    nanos: number,
    regions = ["europe-west1"],
    usageType = "OnDemand"
): Sku {
    return {
        description,
        category: { resourceFamily: "Compute", resourceGroup: group, usageType },
        serviceRegions: regions,
        pricingInfo: [
            {
                pricingExpression: {
                    usageUnit: unit,
                    tieredRates: [{ unitPrice: { currencyCode: "USD", units, nanos } }]
                }
            }
        ]
    };
}

describe("Google billing catalog", () => {
    const skus = [
        sku(
            "E2 Instance Core running in Belgium",
            "CPU",
            "h",
            "0",
            21_811_590,
            ["europe-west1"],
            "Preemptible"
        ),
        sku("E2 Instance Core running in Belgium", "CPU", "h", "0", 21_811_590),
        sku("E2 Instance Ram running in Belgium", "RAM", "GiBy.h", "0", 2_923_530),
        sku("N2 Instance Core running in Belgium", "CPU", "h", "0", 34_773_200),
        sku("E2 Instance Core running in Iowa", "CPU", "h", "0", 1, ["us-central1"])
    ];

    it("picks the region's on-demand E2 core and RAM rates", () => {
        expect(e2Rates(skus, "europe-west1")).toEqual({
            core: 0.02181159,
            ramGiB: 0.00292353,
            currency: "USD"
        });
        expect(e2Rates(skus, "us-central1")).toBeNull();
    });

    it("prices a machine type from its vCPUs and memory", () => {
        const rates = { core: 0.02181159, ramGiB: 0.00292353, currency: "USD" };
        // e2-standard-2: 2 vCPUs, 8 GiB.
        expect(machineHourly(rates, 2, 8192)).toBe(0.067011);
    });
});

describe("price cache", () => {
    it("keeps a price for a day", () => {
        const now = new Date("2026-05-02T12:00:00Z");
        expect(priceFresh(new Date(now.getTime() - PRICE_TTL_MS + 1000), now)).toBe(true);
        expect(priceFresh(new Date(now.getTime() - PRICE_TTL_MS), now)).toBe(false);
    });
});
