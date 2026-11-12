"use server";

/** The world clock's "Add a city": any place's zone, by its name. */

import { calendarT } from "../lib/i18n";
import { requireCalendarUser } from "../lib/access";
import { invalid, outcome, type Outcome } from "../lib/outcome";
import { CalendarRefusal } from "../lib/errors";
import * as places from "../lib/clock/places";

export async function searchPlacesAction(
    input: unknown
): Promise<Outcome<{ places: places.PlaceResult[] }>> {
    const parsed = places.placeQuerySchema.safeParse(input);
    if (!parsed.success) return invalid(parsed.error.issues);
    return outcome(async () => {
        await requireCalendarUser();
        try {
            return { places: await places.searchPlaces(parsed.data.query, parsed.data.language) };
        } catch (caught) {
            if (!(caught instanceof places.PlaceSearchError)) throw caught;
            console.warn("polaris: the place search could not be answered:", caught.message);
            throw new CalendarRefusal((await calendarT())("time.world.searchFailed"));
        }
    });
}
