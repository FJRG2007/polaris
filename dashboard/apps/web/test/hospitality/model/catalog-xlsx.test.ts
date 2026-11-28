/**
 * The menu as a workbook: exported and read back, it is the same catalogue CSV.
 */

import * as xlsx from "xlsx";
import { describe, expect, it } from "vitest";
import { readCatalogCsv } from "@polaris-app/hospitality/src/model/catalog-csv";
import { csvToXlsx, xlsxToCsv } from "@polaris-app/hospitality/src/model/catalog-xlsx";

const CSV = "category,name,price,tax,allergens,code\r\nBebidas,\"Caña, doble\",2.50,10,gluten,\r\nTapas,'=SUM(A1),3.00,10,,T1\r\n";

describe("catalog xlsx", () => {
    it("round-trips the catalogue through a workbook", async () => {
        const bytes = await csvToXlsx(CSV, "Menu", xlsx);
        const back = await xlsxToCsv(bytes.slice().buffer, xlsx);
        expect(readCatalogCsv(back)).toEqual(readCatalogCsv(CSV.replace("'=SUM", "=SUM")));
    });

    it("writes every cell as text, never a formula", async () => {
        const book = xlsx.read(await csvToXlsx(CSV, "Menu", xlsx), { type: "array" });
        const cell = book.Sheets.Menu?.A3 ? book.Sheets.Menu.B3 : undefined;
        expect(cell?.t).toBe("s");
        expect(cell?.f).toBeUndefined();
        expect(cell?.v).toBe("=SUM(A1)");
    });
});
