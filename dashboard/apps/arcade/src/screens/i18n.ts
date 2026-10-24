import type { Translator } from "@polaris/core";
import { hostUi } from "@polaris/app-host/client";
import { arcadeCatalogs, type ArcadeKey } from "../../messages";

export function useArcadeT(): Translator<ArcadeKey> {
    return arcadeCatalogs.translator(hostUi.i18nProvider.useLocale(), "arcade");
}
