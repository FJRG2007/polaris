/**
 * Notes pinned to a moment on a site's traffic chart (Plausible's and Umami's
 * annotations): a release, a campaign, an outage. Anyone who can read the site
 * sees them on the chart; anyone who can edit it adds and removes them.
 */

import { z } from "zod";
import { prisma } from "@polaris/db";

/** Notes one site may hold; past it the oldest has to go before a new one. */
export const ANNOTATION_CAP = 500;

/** Notes read with one window, however many it holds. */
const WINDOW_TAKE = 200;

export const annotationInputSchema = z.object({
    at: z.number().int().min(Date.UTC(2000, 0, 1)).max(Date.UTC(2100, 0, 1)),
    text: z
        .string()
        .transform((value) => value.trim().replace(/\s+/g, " "))
        .pipe(z.string().min(1).max(200))
});
export type AnnotationInput = z.infer<typeof annotationInputSchema>;

export interface AnnotationView {
    readonly id: string;
    readonly at: number;
    readonly text: string;
}

/** The notes inside a window, oldest first. */
export async function annotationsBetween(siteId: string, from: number, to: number): Promise<AnnotationView[]> {
    const rows = await prisma.analyticsAnnotation.findMany({
        where: { siteId, at: { gte: new Date(from), lte: new Date(to) } },
        orderBy: { at: "asc" },
        take: WINDOW_TAKE,
        select: { id: true, at: true, text: true }
    });
    return rows.map((row) => ({ id: row.id, at: row.at.getTime(), text: row.text }));
}

/** Adds a note; null when the site already holds `ANNOTATION_CAP`. */
export async function createAnnotation(
    siteId: string,
    createdById: string,
    input: AnnotationInput
): Promise<AnnotationView | null> {
    const held = await prisma.analyticsAnnotation.count({ where: { siteId } });
    if (held >= ANNOTATION_CAP) return null;
    const row = await prisma.analyticsAnnotation.create({
        data: { siteId, createdById, at: new Date(input.at), text: input.text },
        select: { id: true, at: true, text: true }
    });
    return { id: row.id, at: row.at.getTime(), text: row.text };
}

/** Removes one of the site's notes; false when it was not there. */
export async function deleteAnnotation(siteId: string, id: string): Promise<boolean> {
    const removed = await prisma.analyticsAnnotation.deleteMany({ where: { id, siteId } });
    return removed.count > 0;
}
