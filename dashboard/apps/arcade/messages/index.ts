import enUS from "./en-US";
import esES from "./es-ES";
import { defineCatalogs, type MessageKey } from "@polaris/core";

export const arcadeCatalogs = defineCatalogs({ "en-US": enUS, "es-ES": esES });

export type ArcadeKey = MessageKey<(typeof enUS)["arcade"]>;
