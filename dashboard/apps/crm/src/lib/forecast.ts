/**
 * The sales forecast over a shelf's opportunities, and the stage odds it
 * weighs open deals by.
 *
 * The database groups the deals by close day, stage and currency and adds
 * their amounts; the periods are made here (`model/forecast`). Only the rows a
 * forecast can use are read: open deals of any date, and won ones inside the
 * range. Reading needs the right to see opportunities; changing the odds, the
 * right to change them.
 *
 * Server-only.
 */

import { prisma } from "@polaris/db";
import * as model from "../model/forecast";
import * as flow from "../model/stage-flow";
import { ownClause, requireCan, requireShown, shelfData, shelfWhere, type CrmActor } from "./access";

/** Groups a forecast reads at most; past this it says it is incomplete. */
export const ROW_CAP = 20_000;

export async function loadOdds(actor: CrmActor): Promise<model.Odds> {
    const row = await prisma.crmForecast.findUnique({
        where: { shelf: actor.shelf.key },
        select: { odds: true }
    });
    if (!row) return model.DEFAULT_ODDS;
    try {
        return model.readOdds(JSON.parse(row.odds));
    } catch {
        return model.DEFAULT_ODDS;
    }
}

export async function saveOdds(actor: CrmActor, odds: model.Odds): Promise<model.Odds> {
    await requireCan(actor, "opportunities", "edit");
    const clean = model.readOdds(odds);
    const stored = JSON.stringify(clean);
    await prisma.crmForecast.upsert({
        where: { shelf: actor.shelf.key },
        create: { ...shelfData(actor.shelf), shelf: actor.shelf.key, odds: stored },
        update: { odds: stored }
    });
    return clean;
}

interface GroupRow {
    closeDate: Date | null;
    stage: string;
    amountCurrency: string;
    _count: { _all: number };
    _sum: { amount: unknown };
}

export async function forecast(
    actor: CrmActor,
    input: model.ForecastInput,
    now = new Date()
): Promise<model.Forecast> {
    await requireCan(actor, "opportunities", "read");
    await requireShown(actor, "opportunities", ["amount", "stage", "closeDate"]);
    const own = ownClause(actor, "opportunities");
    const range = model.forecastRange(now, input.granularity, input.periods);
    const start = new Date(`${range.starts[0]}T00:00:00Z`);
    const end = new Date(`${range.end}T00:00:00Z`);
    const [odds, rows] = await Promise.all([
        loadOdds(actor),
        prisma.crmOpportunity.groupBy({
            by: ["closeDate", "stage", "amountCurrency"],
            where: {
                ...shelfWhere(actor.shelf),
                deletedAt: null,
                ...(input.mine ? { ownerId: actor.user.id } : {}),
                AND: [
                    { stage: { not: "lost" } },
                    { OR: [{ closeDate: null }, { closeDate: { lt: end } }] },
                    { OR: [{ stage: { not: model.WON_STAGE } }, { closeDate: { gte: start } }] },
                    ...(own ? [own] : [])
                ]
            },
            _count: { _all: true },
            _sum: { amount: true },
            orderBy: [{ closeDate: "asc" }, { stage: "asc" }, { amountCurrency: "asc" }],
            take: ROW_CAP + 1
        }) as unknown as Promise<GroupRow[]>
    ]);
    const capped = rows.length > ROW_CAP;
    return model.buildForecast(
        rows.slice(0, ROW_CAP).map((row) => ({
            closeDate: row.closeDate,
            stage: row.stage,
            currency: row.amountCurrency,
            deals: row._count._all,
            amount: row._sum.amount === null ? null : Number(row._sum.amount)
        })),
        odds,
        range,
        input.granularity,
        capped
    );
}

/** The most deals, and stage moves, one reading of the stage flow counts. */
export const FLOW_DEALS = 2_000;
export const FLOW_EVENTS = 20_000;

/** How deals moved through the stages, and why they were won or lost. Reads
 *  the newest deals only, flagged when there are more. */
export async function stageFlow(
    actor: CrmActor,
    input: { mine: boolean }
): Promise<flow.StageFlow> {
    await requireCan(actor, "opportunities", "read");
    await requireShown(actor, "opportunities", ["stage"]);
    const own = ownClause(actor, "opportunities");
    const where = {
        ...shelfWhere(actor.shelf),
        deletedAt: null,
        ...(input.mine ? { ownerId: actor.user.id } : {}),
        ...(own ? { AND: [own] } : {})
    };
    const reasonShown = !(actor.rules?.opportunities.hidden ?? []).includes("closeReason");
    const [deals, reasons] = await Promise.all([
        prisma.crmOpportunity.findMany({
            where,
            orderBy: { id: "desc" },
            take: FLOW_DEALS + 1,
            select: { id: true, stage: true, createdAt: true }
        }),
        reasonShown
            ? (prisma.crmOpportunity.groupBy({
                  by: ["stage", "closeReason"],
                  where: { ...where, stage: { in: [model.WON_STAGE, flow.LOST_STAGE] } },
                  _count: { _all: true },
                  orderBy: [{ stage: "asc" }, { closeReason: "asc" }],
                  take: ROW_CAP
              }) as unknown as Promise<
                  { stage: string; closeReason: string; _count: { _all: number } }[]
              >)
            : Promise.resolve([])
    ]);
    const kept = deals.slice(0, FLOW_DEALS);
    const events = kept.length
        ? await prisma.crmEvent.findMany({
              where: {
                  ...shelfWhere(actor.shelf),
                  object: "opportunities",
                  recordId: { in: kept.map((deal) => deal.id) },
                  changes: { contains: '"key":"stage"' }
              },
              orderBy: { id: "asc" },
              take: FLOW_EVENTS + 1,
              select: { recordId: true, createdAt: true, changes: true }
          })
        : [];
    return flow.buildStageFlow(
        kept,
        events
            .slice(0, FLOW_EVENTS)
            .map((event) => ({ recordId: event.recordId, at: event.createdAt, changes: event.changes })),
        reasons.map((row) => ({
            stage: row.stage,
            reason: row.closeReason,
            deals: row._count._all
        })),
        deals.length > FLOW_DEALS || events.length > FLOW_EVENTS
    );
}
