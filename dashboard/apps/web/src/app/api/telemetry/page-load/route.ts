// Telemetry: one of Polaris' own page loads, as the browser measured it, into
// its own project. Sent by `components/telemetry/page-timing`, already sampled.
import { z } from "zod";
import { actionRoute } from "@/lib/poll-route";
import { measurePageLoad } from "@/lib/telemetry/capture";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** A minute is far past any page load worth keeping; CLS is in thousandths. */
const reading = z.number().finite().nonnegative().max(60_000).optional();

const body = z.object({
    path: z.string().trim().min(1).max(500).startsWith("/"),
    values: z
        .object({ lcp: reading, fcp: reading, ttfb: reading, inp: reading, cls: reading })
        .strict()
        .refine((values) => Object.values(values).some((value) => value !== undefined))
});

export const POST = actionRoute(body, async ({ path, values }) => {
    measurePageLoad(path, values);
    return true;
});
