/**
 * The fourteen allergens EU Regulation 1169/2011 (Annex II) requires a menu to
 * declare. Keys are stored; labels come from the catalogs. Aliases are what a
 * spreadsheet typed in English or Spanish may say, folded to lower case with
 * no accents.
 */

export const ALLERGENS = [
    { key: "gluten", aliases: ["cereals", "cereales", "trigo", "wheat"] },
    { key: "crustaceans", aliases: ["crustaceos", "shellfish", "marisco"] },
    { key: "eggs", aliases: ["egg", "huevo", "huevos"] },
    { key: "fish", aliases: ["pescado"] },
    { key: "peanuts", aliases: ["peanut", "cacahuete", "cacahuetes"] },
    { key: "soy", aliases: ["soya", "soja"] },
    { key: "milk", aliases: ["lactose", "lactosa", "leche", "lacteos", "dairy"] },
    { key: "nuts", aliases: ["frutos de cascara", "frutos secos", "tree nuts"] },
    { key: "celery", aliases: ["apio"] },
    { key: "mustard", aliases: ["mostaza"] },
    { key: "sesame", aliases: ["sesamo"] },
    { key: "sulphites", aliases: ["sulfitos", "sulfites", "sulphur dioxide"] },
    { key: "lupin", aliases: ["altramuces", "altramuz"] },
    { key: "molluscs", aliases: ["moluscos"] }
] as const;

export type Allergen = (typeof ALLERGENS)[number]["key"];

export const ALLERGEN_KEYS = ALLERGENS.map((a) => a.key) as [Allergen, ...Allergen[]];
