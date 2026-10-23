/** Thousands separators without a locale. Deliberately hand-rolled: toLocaleString
 *  would pick a separator from the browser, which disagrees with the server on the
 *  first render and is not the operator's chosen format either. */
export function grouped(value: number): string {
    return String(Math.round(value)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}
