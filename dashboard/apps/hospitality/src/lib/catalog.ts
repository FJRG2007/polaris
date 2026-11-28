/**
 * The shared menu and the venues that sell it. Every function is called by an
 * action that has already checked the permission and validated its input.
 *
 * Server-only.
 */

import { z } from "zod";
import { prisma } from "@polaris/db";
import { HospitalityRefusal } from "./outcome";
import { changedPrice } from "../model/pricing";
import { publishHospitalityChange } from "./live";
import type { Allergen } from "../model/allergens";
import { readCatalogCsv, writeCatalogCsv, type CsvProduct } from "../model/catalog-csv";
import { modifierGroupSchema, type BulkPriceInput, type CategoryInput, type ModifierGroup, type ProductInput, type VenueInput } from "../model/schemas";

export interface VenueView {
    readonly id: string;
    readonly name: string;
    readonly businessName: string;
    readonly taxId: string;
    readonly address: string;
    readonly currency: string;
    readonly footer: string;
    readonly ticketPrefix: string;
}

export interface CategoryView {
    readonly id: string;
    readonly name: string;
    readonly color: string;
    readonly station: string;
}

export interface ProductView {
    readonly id: string;
    readonly categoryId: string;
    readonly name: string;
    readonly description: string;
    /** The venue's price when it overrides the menu's. */
    readonly price: number;
    readonly menuPrice: number;
    readonly taxRateBp: number;
    readonly allergens: Allergen[];
    readonly sku: string | null;
    readonly station: string | null;
    readonly imageUrl: string | null;
    readonly modifiers: ModifierGroup[];
    /** False when the menu or this venue has it off ("86"). */
    readonly available: boolean;
}

export interface MenuView {
    readonly venues: VenueView[];
    readonly venueId: string | null;
    readonly categories: CategoryView[];
    readonly products: ProductView[];
}

const groups = z.array(modifierGroupSchema);

/** A stored modifiers column read total: anything unreadable is no modifiers. */
function readModifiers(raw: unknown): ModifierGroup[] {
    const parsed = groups.safeParse(raw ?? []);
    return parsed.success ? parsed.data : [];
}

const VENUE_SELECT = {
    id: true,
    name: true,
    businessName: true,
    taxId: true,
    address: true,
    currency: true,
    footer: true,
    ticketPrefix: true
} as const;

export async function readMenu(venueId: string | null): Promise<MenuView> {
    const [venues, categories, products] = await Promise.all([
        prisma.hospitalityVenue.findMany({ select: VENUE_SELECT, orderBy: [{ position: "asc" }, { createdAt: "asc" }], take: 200 }),
        prisma.hospitalityCategory.findMany({
            select: { id: true, name: true, color: true, station: true },
            orderBy: [{ position: "asc" }, { createdAt: "asc" }],
            take: 500
        }),
        prisma.hospitalityProduct.findMany({
            orderBy: [{ position: "asc" }, { createdAt: "asc" }],
            take: 5000
        })
    ]);
    const venue = venues.find((v) => v.id === venueId) ?? venues[0] ?? null;
    const overrides = venue
        ? await prisma.hospitalityPriceOverride.findMany({ where: { venueId: venue.id } })
        : [];
    const byProduct = new Map(overrides.map((o) => [o.productId, o]));
    return {
        venues,
        venueId: venue?.id ?? null,
        categories,
        products: products.map((p) => {
            const own = byProduct.get(p.id);
            return {
                id: p.id,
                categoryId: p.categoryId,
                name: p.name,
                description: p.description,
                price: own?.price ?? p.price,
                menuPrice: p.price,
                taxRateBp: p.taxRateBp,
                allergens: p.allergens as Allergen[],
                sku: p.sku,
                station: p.station,
                imageUrl: p.imageUrl,
                modifiers: readModifiers(p.modifiers),
                available: p.available && (own?.available ?? true)
            };
        })
    };
}

export async function saveVenue(input: VenueInput, actorId: string): Promise<string> {
    const { id, ...data } = input;
    const saved = id
        ? await prisma.hospitalityVenue.update({ where: { id }, data, select: { id: true } })
        : await prisma.hospitalityVenue.create({ data, select: { id: true } });
    publishHospitalityChange({ venueId: saved.id, actorId, topic: "menu" });
    return saved.id;
}

export async function saveCategory(input: CategoryInput, actorId: string): Promise<string> {
    const { id, ...data } = input;
    const saved = id
        ? await prisma.hospitalityCategory.update({ where: { id }, data, select: { id: true } })
        : await prisma.hospitalityCategory.create({
              data: { ...data, position: Date.now() },
              select: { id: true }
          });
    publishHospitalityChange({ venueId: null, actorId, topic: "menu" });
    return saved.id;
}

export async function deleteCategory(id: string, actorId: string): Promise<void> {
    const used = await prisma.hospitalityProduct.count({ where: { categoryId: id } });
    if (used > 0) throw new HospitalityRefusal("menu.categoryNotEmpty");
    await prisma.hospitalityCategory.deleteMany({ where: { id } });
    publishHospitalityChange({ venueId: null, actorId, topic: "menu" });
}

export async function saveProduct(input: ProductInput, actorId: string): Promise<string> {
    const { id, modifiers, ...rest } = input;
    const data = { ...rest, modifiers: modifiers as unknown as object };
    const saved = id
        ? await prisma.hospitalityProduct.update({ where: { id }, data, select: { id: true } })
        : await prisma.hospitalityProduct.create({ data: { ...data, position: Date.now() }, select: { id: true } });
    publishHospitalityChange({ venueId: null, actorId, topic: "menu" });
    return saved.id;
}

export async function deleteProduct(id: string, actorId: string): Promise<void> {
    await prisma.hospitalityProduct.deleteMany({ where: { id } });
    publishHospitalityChange({ venueId: null, actorId, topic: "menu" });
}

/** On or off ("86", sold out) for one venue, or for the whole menu when `venueId` is null. */
export async function setAvailability(productId: string, venueId: string | null, available: boolean, actorId: string) {
    if (venueId) {
        await prisma.hospitalityPriceOverride.upsert({
            where: { venueId_productId: { venueId, productId } },
            create: { venueId, productId, available },
            update: { available }
        });
    } else {
        await prisma.hospitalityProduct.update({ where: { id: productId }, data: { available } });
    }
    publishHospitalityChange({ venueId, actorId, topic: "menu" });
}

/** One price change over a category (or the whole menu), in one transaction. */
export async function bulkPrice(input: BulkPriceInput, actorId: string): Promise<number> {
    const products = await prisma.hospitalityProduct.findMany({
        where: input.categoryId ? { categoryId: input.categoryId } : undefined,
        select: { id: true, price: true }
    });
    const changes = products
        .map((p) => ({ id: p.id, price: changedPrice(p.price, input) }))
        .filter((p, i) => p.price !== products[i].price);
    await prisma.$transaction(
        changes.map((c) => prisma.hospitalityProduct.update({ where: { id: c.id }, data: { price: c.price } }))
    );
    publishHospitalityChange({ venueId: null, actorId, topic: "menu" });
    return changes.length;
}

/**
 * Reads a menu spreadsheet. A category that does not exist yet is made; a
 * product is matched by its code when it has one, else by name inside its
 * category, and updated in place - so importing the same file twice changes
 * nothing, and importing a corrected one updates the prices.
 */
export async function importCatalog(csv: string, actorId: string) {
    const read = readCatalogCsv(csv);
    const categories = await prisma.hospitalityCategory.findMany({ select: { id: true, name: true } });
    const categoryId = new Map(categories.map((c) => [c.name.toLowerCase(), c.id]));
    let created = 0;
    let updated = 0;
    for (const row of read.products) {
        let category = categoryId.get(row.category.toLowerCase());
        if (!category) {
            category = (
                await prisma.hospitalityCategory.create({
                    data: { name: row.category, position: Date.now() + categoryId.size, station: row.station ?? "kitchen" },
                    select: { id: true }
                })
            ).id;
            categoryId.set(row.category.toLowerCase(), category);
        }
        const existing = await prisma.hospitalityProduct.findFirst({
            where: row.sku ? { sku: row.sku } : { categoryId: category, name: { equals: row.name, mode: "insensitive" } },
            select: { id: true }
        });
        const data = {
            categoryId: category,
            name: row.name,
            description: row.description,
            price: row.price,
            taxRateBp: row.taxRateBp,
            allergens: row.allergens,
            sku: row.sku,
            station: row.station,
            imageUrl: row.imageUrl,
            available: row.available
        };
        if (existing) {
            await prisma.hospitalityProduct.update({ where: { id: existing.id }, data });
            updated += 1;
        } else {
            await prisma.hospitalityProduct.create({ data: { ...data, position: Date.now() + created } });
            created += 1;
        }
    }
    publishHospitalityChange({ venueId: null, actorId, topic: "menu" });
    return { created, updated, skipped: read.skipped };
}

export async function exportCatalog(): Promise<string> {
    const menu = await readMenu(null);
    const names = new Map(menu.categories.map((c) => [c.id, c.name]));
    const rows: CsvProduct[] = menu.products.map((p) => ({
        category: names.get(p.categoryId) ?? "",
        name: p.name,
        price: p.menuPrice,
        taxRateBp: p.taxRateBp,
        allergens: p.allergens,
        sku: p.sku,
        description: p.description,
        available: p.available,
        station: p.station,
        imageUrl: p.imageUrl
    }));
    return writeCatalogCsv(rows);
}

/**
 * First run: a venue, a short sample menu and a room with eight tables, so a
 * restaurant can take an order in the first minute and edit from there. Does
 * nothing when a venue already exists.
 */
export async function seedSample(words: { venue: string; room: string; sample: string }, actorId: string) {
    if ((await prisma.hospitalityVenue.count()) > 0) return;
    const venue = await prisma.hospitalityVenue.create({ data: { name: words.venue }, select: { id: true } });
    const room = await prisma.hospitalityRoom.create({ data: { venueId: venue.id, name: words.room }, select: { id: true } });
    await prisma.hospitalityTable.createMany({
        data: Array.from({ length: 8 }, (_, i) => ({
            roomId: room.id,
            name: String(i + 1),
            x: (i % 4) * 3 + 1,
            y: Math.floor(i / 4) * 3 + 1,
            shape: i % 3 === 2 ? "round" : "square",
            seats: i % 4 === 3 ? 6 : 4
        }))
    });
    if ((await prisma.hospitalityProduct.count()) === 0) await importCatalog(words.sample, actorId);
    publishHospitalityChange({ venueId: venue.id, actorId, topic: "floor" });
}
