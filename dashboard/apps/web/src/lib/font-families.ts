/** The faces offered wherever text is set - a document, a slide. Ones every
 *  operating system has, so a document set in one reads the same on the
 *  machine it is opened on. Proper names, never translated. */
export const FONT_FAMILIES = [
    "Arial",
    "Georgia",
    "Times New Roman",
    "Verdana",
    "Trebuchet MS",
    "Courier New"
] as const;

export type FontFamily = (typeof FONT_FAMILIES)[number];
