import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ENGLISH_UI_STRINGS, TimeSeriesChart, UiStringsProvider } from "@polaris/ui";

const catalog = (locale: string) =>
    JSON.parse(readFileSync(join(__dirname, "../../../messages", locale, "components.json"), "utf8")) as {
        ui: Record<string, string>;
    };

const points = [
    { t: 1_000, v: 2 },
    { t: 2_000, v: 4 }
];

describe("chart summary words", () => {
    it("draws avg and peak in the reader's words, not hardcoded English", () => {
        const es = catalog("es-ES").ui;
        const html = renderToStaticMarkup(
            <UiStringsProvider
                strings={{ ...ENGLISH_UI_STRINGS, seriesAverage: es.seriesAverage!, seriesPeak: es.seriesPeak! }}
            >
                <TimeSeriesChart points={points} from={1_000} to={2_000} label="CPU" />
            </UiStringsProvider>
        );
        expect(html).toContain(`${es.seriesAverage} 3`);
        expect(html).toContain(`${es.seriesPeak} 4`);
        expect(html).not.toMatch(/>avg |>peak /);
    });

    it("has both words in every catalog", () => {
        for (const locale of ["en-US", "es-ES"]) {
            const ui = catalog(locale).ui;
            expect(ui.seriesAverage).toBeTruthy();
            expect(ui.seriesPeak).toBeTruthy();
        }
    });
});
