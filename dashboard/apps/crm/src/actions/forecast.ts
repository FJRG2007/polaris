"use server";

/**
 * The sales forecast, and the stage odds behind it. Every input is checked
 * against a schema here.
 */

import * as forecast from "../lib/forecast";
import { requireCrmActor } from "../lib/access";
import { invalid, outcome, type Outcome } from "../lib/outcome";
import { forecastInputSchema, oddsSchema, type Forecast, type Odds } from "../model/forecast";
import { stageFlowInputSchema, type StageFlow } from "../model/stage-flow";

export interface ForecastReading {
    readonly forecast: Forecast;
    /** Whether the reader may change the stage odds. */
    readonly canEditOdds: boolean;
}

export async function forecastAction(input: unknown): Promise<Outcome<ForecastReading>> {
    const parsed = forecastInputSchema.safeParse(input);
    if (!parsed.success) return invalid();
    return outcome(async () => {
        const actor = await requireCrmActor();
        return {
            forecast: await forecast.forecast(actor, parsed.data),
            canEditOdds: actor.can.opportunities.edit
        };
    });
}

export async function saveOddsAction(input: unknown): Promise<Outcome<{ odds: Odds }>> {
    const parsed = oddsSchema.safeParse(input);
    if (!parsed.success) return invalid();
    return outcome(async () => ({
        odds: await forecast.saveOdds(await requireCrmActor(), parsed.data)
    }));
}

export async function stageFlowAction(input: unknown): Promise<Outcome<{ flow: StageFlow }>> {
    const parsed = stageFlowInputSchema.safeParse(input);
    if (!parsed.success) return invalid();
    return outcome(async () => ({
        flow: await forecast.stageFlow(await requireCrmActor(), parsed.data)
    }));
}
