/**
 * A UPS handed out as a link, read and driven by somebody with no account.
 *
 * The link is a grant like any other (principal `link`, see
 * `lib/access/grants.ts`): the same dates, hours, uses, actions and fence.
 * Watching reads its status, from a reading shared a few seconds between
 * every holder; control also sends it the commands it lists (the self-test
 * among them) except those that cut the power, each rate-limited by link and
 * address, recorded with no actor, and counted only once the UPS answered.
 *
 * What it never shows a guest is where it is reached or what it shuts down:
 * only its name and how it is doing.
 *
 * Server-only.
 */

import * as core from "@polaris/core";
import * as upsData from "@/lib/ups/ups-data";
import { upsNearby } from "@/lib/ups/ups-access";
import { recordAudit } from "@/lib/audit-service";
import * as upsService from "@/lib/ups/ups-service";
import { rateLimit } from "@/lib/rate-limit-service";
import type * as upsReading from "@/lib/ups/ups-reading";
import { isDangerousCommand } from "@/app/(app)/places/ups/ups-words";
import { linkReach, recordGrantUse, spendGrant, type LiveGrant } from "@/lib/access/grants";

/** Commands per link and address, a minute. */
const COMMANDS_PER_MINUTE = 6;

/** How long one reading answers every link to the same UPS. */
const READ_TTL_MS = 10_000;

const readings = new Map<string, { at: number; result: Promise<upsService.UpsReadResult> }>();

type UpsRow = NonNullable<Awaited<ReturnType<typeof upsService.getUps>>>;

/** What a guest link to a UPS shows. */
export interface UpsGuestView {
    readonly name: string;
    readonly control: boolean;
    readonly nearbyMeters: number | null;
    readonly until: string | null;
    /** How it is doing now, or null when it did not answer. */
    readonly reading: Pick<
        upsReading.UpsReading,
        "status" | "charge" | "runtimeS" | "load" | "testResult"
    > | null;
    /** The commands it lists, for a link that may send them. */
    readonly commands: readonly string[];
}

export type UpsGuestRefusal =
    "closed" | "notThat" | "tooMany" | `nearby${Capitalize<Exclude<core.NearbyVerdict, "near">>}`;

/** The live grant and row behind a UPS link, or null when it opens nothing. */
async function reached(
    token: string
): Promise<{ grant: LiveGrant; row: UpsRow; note: string } | null> {
    const link = await linkReach(token);
    if (!link || link.subjectType !== "place.ups" || link.standing !== "live") return null;
    const row = await upsService.getUps(link.subjectId);
    return row ? { grant: link.grant, row, note: link.note } : null;
}

/** One row of the access log for a UPS link's command. */
function logCommand(
    grant: LiveGrant,
    row: UpsRow,
    note: string,
    outcome: "done" | "refused",
    reason = ""
): Promise<void> {
    return recordGrantUse({
        grantId: grant.id,
        subjectType: "place.ups",
        subjectId: row.id,
        targetType: "ups",
        targetId: row.id,
        userId: null,
        linkNote: note,
        action: "command",
        outcome,
        reason
    });
}

/** The UPS's reading, asked of it at most once per `READ_TTL_MS` however many
 *  links and tabs poll it. */
function sharedReading(row: UpsRow): Promise<upsService.UpsReadResult> {
    const now = Date.now();
    const kept = readings.get(row.id);
    if (kept && now - kept.at < READ_TTL_MS) return kept.result;
    for (const [id, one] of readings) if (now - one.at >= READ_TTL_MS) readings.delete(id);
    const result = upsService.readUps(row);
    readings.set(row.id, { at: now, result });
    result.catch(() => readings.delete(row.id));
    return result;
}

/** Whether a UPS link's address names a UPS at all, and how it stands. */
export async function upsLinkStanding(token: string): Promise<core.GrantStanding | null> {
    const link = await linkReach(token);
    return link && link.subjectType === "place.ups" ? link.standing : null;
}

/** What the guest page draws, read now. */
export async function upsGuestView(token: string): Promise<UpsGuestView | null> {
    const found = await reached(token);
    if (!found) return null;
    const control = found.grant.actions.includes("control");
    const result = await sharedReading(found.row);
    const reading = result.ok ? result.reading : null;
    return {
        name: found.row.name,
        control,
        nearbyMeters: found.grant.nearbyMeters ?? null,
        until: found.grant.until?.toISOString() ?? null,
        reading: reading
            ? {
                  status: reading.status,
                  charge: reading.charge,
                  runtimeS: reading.runtimeS,
                  load: reading.load,
                  testResult: reading.testResult
              }
            : null,
        commands:
            control && reading
                ? reading.commands.filter((command) => !isDangerousCommand(command))
                : []
    };
}

/** Send one command through a link that may drive the UPS. */
export async function pressUpsGuest(
    token: string,
    command: string,
    where: core.ReportedLocation | null,
    ip: string
): Promise<
    { ok: true; outcome: upsService.UpsCommandResult } | { ok: false; error: UpsGuestRefusal }
> {
    const found = await reached(token);
    if (!found) return { ok: false, error: "closed" };
    const { grant, row, note } = found;
    if (!grant.actions.includes("control") || isDangerousCommand(command)) {
        await logCommand(grant, row, note, "refused", "notThat");
        return { ok: false, error: "notThat" };
    }
    const limited = await rateLimit(`guest-ups:${grant.id}:${ip}`, COMMANDS_PER_MINUTE, 60_000);
    if (!limited.ok) return { ok: false, error: "tooMany" };
    const verdict = await upsNearby(grant, row.placeId, where);
    if (verdict) {
        await logCommand(grant, row, note, "refused", "notNearby");
        return {
            ok: false,
            error: `nearby${verdict[0]!.toUpperCase()}${verdict.slice(1)}` as UpsGuestRefusal
        };
    }
    const outcome = await upsService.runUpsCommand(row, command);
    await logCommand(
        grant,
        row,
        note,
        outcome === "ok" ? "done" : "refused",
        outcome === "ok" ? "" : "failed"
    );
    if (outcome === "ok") {
        await spendGrant(grant).catch((caught: unknown) =>
            console.error("polaris: a UPS link use could not be counted:", caught)
        );
    }
    await upsData.logAction({
        upsId: row.id,
        actorId: null,
        kind: "command",
        name: command,
        outcome
    });
    await recordAudit({
        actorId: null,
        action: "ups.command",
        targetType: "ups",
        targetId: row.id,
        metadata: {
            command,
            outcome,
            lent: true,
            link: true,
            ...(grant.nearbyMeters ? { nearby: true } : {})
        }
    });
    return { ok: true, outcome };
}
