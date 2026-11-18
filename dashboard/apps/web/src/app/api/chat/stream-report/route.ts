// Chat: somebody reporting a problem with the screen they are sharing, into
// Polaris' own Telemetry project, with the stream's settings beside it so an
// administrator reading it knows what was going out.
import { z } from "zod";
import { actionRoute } from "@/lib/poll-route";
import { captureInternal } from "@/lib/telemetry/capture";
import { STREAM_PROBLEMS } from "@/app/(app)/chat/stream-report-kinds";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const body = z.object({
    problem: z.enum(STREAM_PROBLEMS),
    note: z
        .string()
        .trim()
        .max(500)
        // Read as one line in the event's tags.
        .transform((note) => note.replace(/[\u0000-\u001f\u007f]+/g, " ")),
    settings: z
        .object({
            mode: z.enum(["auto", "gaming", "screenshare", "custom"]),
            frameRate: z.number().int().min(1).max(240).nullable(),
            resolution: z.string().trim().max(12).nullable(),
            sound: z.boolean(),
            platform: z.enum(["desktop", "browser"])
        })
        .strict()
});

export const POST = actionRoute(body, async ({ problem, note, settings }) => {
    const report = new Error(`Stream problem reported: ${problem}`);
    report.name = "StreamReport";
    await captureInternal(report, {
        level: "warning",
        transaction: "chat/stream",
        tags: {
            problem,
            mode: settings.mode,
            frameRate: settings.frameRate === null ? "auto" : String(settings.frameRate),
            resolution: settings.resolution ?? "auto",
            sound: settings.sound ? "on" : "off",
            platform: settings.platform,
            ...(note ? { note } : {})
        }
    });
    return true;
});
