// xlsx-populate ships no type declarations, and its main entry is Node-only; the
// browser bundle is imported directly instead. The spreadsheet editor only sets
// cell values on an existing workbook and serializes it back, so the surface
// declared here is deliberately the minimum that use needs.
declare module "xlsx-populate/browser/xlsx-populate-no-encryption.min.js" {
    interface XlsxCell {
        value(value: string | number | boolean | null): XlsxCell;
        formula(formula: string): XlsxCell;
    }

    interface XlsxSheet {
        /** 1-based row and column. */
        cell(row: number, column: number): XlsxCell;
    }

    interface XlsxWorkbook {
        sheet(nameOrIndex: string | number): XlsxSheet | undefined;
        outputAsync(type: "blob"): Promise<Blob>;
    }

    const XlsxPopulate: {
        fromDataAsync(data: ArrayBuffer | Uint8Array | Blob): Promise<XlsxWorkbook>;
    };
    export default XlsxPopulate;
}
