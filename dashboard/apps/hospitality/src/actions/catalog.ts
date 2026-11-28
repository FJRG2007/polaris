"use server";

/**
 * Everything the menu screens ask the server. Each action validates its input
 * before any work; reading the menu needs `hospitality.use` (a waiter), every
 * change needs `hospitality.manage`.
 */

import { z } from "zod";
import * as catalog from "../lib/catalog";
import { ownVenue } from "../lib/audit";
import { hospitalityT } from "../lib/i18n";
import { invalid, outcome, type Outcome } from "../lib/outcome";
import {
    availabilityInput,
    bulkPriceInput,
    categoryInput,
    idInput,
    importInput,
    productInput,
    venueInput
} from "../model/schemas";

const venueQuery = z.object({ venueId: z.string().uuid().nullable() });

export async function readMenuAction(raw: unknown): Promise<Outcome<{ menu: catalog.MenuView }>> {
    const input = venueQuery.safeParse(raw);
    if (!input.success) return invalid();
    return outcome("hospitality.use", async (user) => {
        const venueId = user.device ? (input.data.venueId ?? user.venueId ?? null) : input.data.venueId;
        if (user.device) ownVenue(user, venueId);
        return { menu: await catalog.readMenu(venueId) };
    });
}

export async function saveVenueAction(raw: unknown): Promise<Outcome<{ id: string }>> {
    const input = venueInput.safeParse(raw);
    if (!input.success) return invalid();
    return outcome("hospitality.manage", async (user) => ({ id: await catalog.saveVenue(input.data, user.id) }));
}

export async function saveCategoryAction(raw: unknown): Promise<Outcome<{ id: string }>> {
    const input = categoryInput.safeParse(raw);
    if (!input.success) return invalid();
    return outcome("hospitality.manage", async (user) => ({ id: await catalog.saveCategory(input.data, user.id) }));
}

export async function deleteCategoryAction(raw: unknown): Promise<Outcome<object>> {
    const input = idInput.safeParse(raw);
    if (!input.success) return invalid();
    return outcome("hospitality.manage", async (user) => (await catalog.deleteCategory(input.data.id, user.id), {}));
}

export async function saveProductAction(raw: unknown): Promise<Outcome<{ id: string }>> {
    const input = productInput.safeParse(raw);
    if (!input.success) return invalid();
    return outcome("hospitality.manage", async (user) => ({ id: await catalog.saveProduct(input.data, user.id) }));
}

export async function deleteProductAction(raw: unknown): Promise<Outcome<object>> {
    const input = idInput.safeParse(raw);
    if (!input.success) return invalid();
    return outcome("hospitality.manage", async (user) => (await catalog.deleteProduct(input.data.id, user.id), {}));
}

/** Sold out / back on. A waiter may do it: the kitchen runs out mid-service. */
export async function setAvailabilityAction(raw: unknown): Promise<Outcome<object>> {
    const input = availabilityInput.safeParse(raw);
    if (!input.success) return invalid();
    const { productId, venueId, available } = input.data;
    return outcome(venueId ? "hospitality.use" : "hospitality.manage", async (user) => {
        await catalog.setAvailability(productId, venueId, available, user.id);
        return {};
    });
}

export async function bulkPriceAction(raw: unknown): Promise<Outcome<{ changed: number }>> {
    const input = bulkPriceInput.safeParse(raw);
    if (!input.success) return invalid();
    return outcome("hospitality.manage", async (user) => ({ changed: await catalog.bulkPrice(input.data, user.id) }));
}

export async function importCatalogAction(
    raw: unknown
): Promise<Outcome<{ created: number; updated: number; skipped: Array<{ row: number; reason: string }> }>> {
    const input = importInput.safeParse(raw);
    if (!input.success) return invalid();
    return outcome("hospitality.manage", (user) => catalog.importCatalog(input.data.csv, user.id));
}

export async function exportCatalogAction(): Promise<Outcome<{ csv: string }>> {
    return outcome("hospitality.manage", async () => ({ csv: await catalog.exportCatalog() }));
}

/** First run: a venue, a sample menu and a room of tables, in the reader's language. */
export async function seedSampleAction(): Promise<Outcome<object>> {
    return outcome("hospitality.manage", async (user) => {
        const t = await hospitalityT();
        await catalog.seedSample(
            { venue: t("setup.sampleVenue"), room: t("setup.sampleRoom"), sample: t("setup.sampleCsv") },
            user.id
        );
        return {};
    });
}
