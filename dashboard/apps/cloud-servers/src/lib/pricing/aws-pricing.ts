/**
 * An EC2 instance type's on-demand Linux price, from the AWS Price List Query
 * API: one GetProducts call filtered to exactly one product.
 *
 * API reference: https://docs.aws.amazon.com/aws-cost-management/latest/APIReference/API_pricing_GetProducts.html
 *   POST https://api.pricing.us-east-1.amazonaws.com/
 *   X-Amz-Target: AWSPriceListService.GetProducts, application/x-amz-json-1.1,
 *   signed with Signature Version 4 for service "pricing" in us-east-1.
 * `PriceList` is an array of JSON documents (strings); the on-demand price is
 * under `terms.OnDemand.*.priceDimensions.*.pricePerUnit.USD` with unit "Hrs".
 *
 * The caller's IAM user needs `pricing:GetProducts`; without it the price is
 * reported as not available rather than estimated.
 */

import { z } from "zod";
import { parseWith, send } from "../http";
import { signV4, type SigV4Credentials } from "../auth/sigv4";

const ENDPOINT = "https://api.pricing.us-east-1.amazonaws.com/";

/** The filter set that leaves exactly the plain on-demand Linux product. */
export function priceFilters(instanceType: string, regionCode: string) {
    const term = (Field: string, Value: string) => ({ Type: "TERM_MATCH", Field, Value });
    return [
        term("instanceType", instanceType),
        term("regionCode", regionCode),
        term("operatingSystem", "Linux"),
        term("tenancy", "Shared"),
        term("preInstalledSw", "NA"),
        term("capacitystatus", "Used")
    ];
}

const productSchema = z.object({
    product: z.object({ attributes: z.record(z.string()).default({}) }),
    terms: z.object({
        OnDemand: z.record(
            z.object({
                priceDimensions: z.record(
                    z.object({ unit: z.string(), pricePerUnit: z.record(z.string()) })
                )
            })
        )
    })
});

/**
 * The hourly USD price among the products returned. Prefers the plain
 * `RunInstances` operation (no bundled licence); null when none carries an
 * hourly price.
 */
export function readHourlyUsd(priceList: readonly string[]): number | null {
    const products = priceList
        .map((raw) => productSchema.safeParse(JSON.parse(raw)))
        .flatMap((parsed) => (parsed.success ? [parsed.data] : []));
    const ranked = [
        ...products.filter((p) => p.product.attributes.operation === "RunInstances"),
        ...products.filter((p) => p.product.attributes.operation !== "RunInstances")
    ];
    for (const product of ranked) {
        for (const term of Object.values(product.terms.OnDemand)) {
            for (const dimension of Object.values(term.priceDimensions)) {
                const usd = Number(dimension.pricePerUnit.USD);
                if (dimension.unit === "Hrs" && Number.isFinite(usd) && usd > 0) return usd;
            }
        }
    }
    return null;
}

export async function awsHourlyPrice(
    credentials: SigV4Credentials,
    instanceType: string,
    regionCode: string
): Promise<number | null> {
    const body = JSON.stringify({
        ServiceCode: "AmazonEC2",
        FormatVersion: "aws_v1",
        MaxResults: 10,
        Filters: priceFilters(instanceType, regionCode)
    });
    const headers = signV4({
        method: "POST",
        url: ENDPOINT,
        headers: {
            "content-type": "application/x-amz-json-1.1",
            "x-amz-target": "AWSPriceListService.GetProducts"
        },
        body,
        service: "pricing",
        region: "us-east-1",
        credentials,
        now: new Date()
    });
    const { host: _host, ...sent } = headers;
    const response = await send(ENDPOINT, { method: "POST", headers: sent, body });
    const answer = parseWith(z.object({ PriceList: z.array(z.string()).max(100) }), await response.json());
    return readHourlyUsd(answer.PriceList);
}
