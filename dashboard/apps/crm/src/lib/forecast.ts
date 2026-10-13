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
