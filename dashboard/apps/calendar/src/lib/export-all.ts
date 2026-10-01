/**
 * Everything of somebody's in one download (Nextcloud's user data export):
 * one .ics per calendar they own, and their booking pages' settings as JSON.
 *
 * Server-only.
 */

import { prisma } from "@polaris/db";
import { zipFiles } from "./zip";
import { exportCalendarRow, fileName } from "./transfer";
import type { SessionUser } from "./access";

export async function exportEverything(user: SessionUser): Promise<Uint8Array> {
    const calendars = await prisma.calendar.findMany({
        where: { ownerId: user.id, trashedAt: null, kind: { not: "resource" } },
        select: { id: true },
        orderBy: { createdAt: "asc" }
    });
    const files: { name: string; text: string }[] = [];
    const taken = new Set<string>();
    for (const calendar of calendars) {
        const file = await exportCalendarRow(calendar.id);
        let name = fileName(file.name, "ics");
        for (let copy = 2; taken.has(name); copy += 1) name = fileName(`${file.name}-${copy}`, "ics");
        taken.add(name);
        files.push({ name, text: file.ics });
    }
    const pages = await prisma.calendarBookingPage.findMany({
        where: { ownerId: user.id },
        select: {
            slug: true,
            title: true,
            description: true,
            location: true,
            visibility: true,
            durationMinutes: true,
            slotMinutes: true,
            bufferBefore: true,
            bufferAfter: true,
            noticeMinutes: true,
            maxPerDay: true,
            horizonDays: true,
            timezone: true,
            availability: true,
            questions: true,
            enabled: true
        }
    });
    if (pages.length > 0) {
        const readable = pages.map((page) => ({
            ...page,
            availability: JSON.parse(page.availability) as unknown,
            questions: JSON.parse(page.questions) as unknown
        }));
        files.push({ name: "booking-pages.json", text: `${JSON.stringify(readable, null, 2)}\n` });
    }
    return zipFiles(files);
}
