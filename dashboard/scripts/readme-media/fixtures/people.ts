/**
 * The people in every scene. Invented, and plainly so: example.com addresses and
 * ids that read as fixtures, so no picture ever carries somebody real.
 */

export interface FixturePerson {
    readonly id: string;
    readonly name: string;
    readonly email: string;
}

const person = (n: number, name: string, handle: string): FixturePerson => ({
    id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
    name,
    email: `${handle}@example.com`
});

/** The account the pictures are taken as. */
export const VIEWER = person(1, "Alex Rivera", "alex");

export const TEAM = {
    ana: person(2, "Ana Torres", "ana"),
    sam: person(3, "Sam Okafor", "sam"),
    lena: person(4, "Lena Fischer", "lena"),
    kenji: person(5, "Kenji Mori", "kenji"),
    priya: person(6, "Priya Nair", "priya")
} as const;

/** The rest of the Northwind space: in its voice rooms and its channels, but
 *  not in every scene's member list. */
export const CREW = {
    mateo: person(7, "Mateo Silva", "mateo"),
    grace: person(8, "Grace Lin", "grace"),
    omar: person(9, "Omar Haddad", "omar"),
    yuki: person(10, "Yuki Tanaka", "yuki")
} as const;

/** The organization the viewer belongs to, which is what puts the shelf switch
 *  in the header of every picture. */
export const ORG = {
    id: "00000000-0000-4000-8000-0000000000a1",
    slug: "northwind",
    name: "Northwind"
};

/** A fixture id that reads as one: `id("channel", 3)`. */
export function id(kind: string, n: number): string {
    const tag = [...kind].reduce((sum, char) => sum + char.charCodeAt(0), 0) % 0xffff;
    return `00000000-${tag.toString(16).padStart(4, "0")}-4000-8000-${String(n).padStart(12, "0")}`;
}

/** An ISO time `minutes` before the scene's moment. */
export function ago(now: number, minutes: number): string {
    return new Date(now - minutes * 60_000).toISOString();
}
