import enUS from "./en-US";
import esES from "./es-ES";
import { defineCatalogs, type MessageKey } from "@polaris/core";

export const arcadeCatalogs = defineCatalogs({ "en-US": enUS, "es-ES": esES });

const BY_LOCALE: Record<string, Record<string, unknown>> = { "en-US": enUS, "es-ES": esES };

/** A game's own words (its namespace, named by the game's id), in `locale` or else in English. */
export function gameMessages(locale: string, gameId: string): unknown {
    return BY_LOCALE[locale]?.[gameId] ?? BY_LOCALE["en-US"]?.[gameId] ?? null;
}

export type ArcadeKey = MessageKey<(typeof enUS)["arcade"]>;
