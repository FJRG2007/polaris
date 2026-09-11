/**
 * The colours Mail tells things apart by: a mailbox's dot, a folder's icon.
 *
 * Eight, and swatches rather than a picker. A menu with an input in it is a menu
 * that steals the input focus the moment it opens - see the note in
 * `@polaris/ui` - and eight is already more than anybody needs to make three
 * mailboxes or three folders findable at a glance. One list, so a mailbox given
 * "Green" on its edit form is the green its folders can be given in the rail.
 */
export const MAIL_PALETTE: readonly { hex: string; name: string }[] = [
    { hex: "#6366f1", name: "Indigo" },
    { hex: "#0ea5e9", name: "Blue" },
    { hex: "#10b981", name: "Green" },
    { hex: "#f59e0b", name: "Amber" },
    { hex: "#ef4444", name: "Red" },
    { hex: "#a855f7", name: "Purple" },
    { hex: "#14b8a6", name: "Teal" },
    { hex: "#f43f5e", name: "Pink" }
];

/**
 * The colours a mailbox is told apart by when its owner has not chosen one.
 *
 * Derived from the address rather than from the row's position, so a mailbox
 * keeps its colour when another is added above it - a rail whose colours shuffle
 * on every change is a rail nobody learns.
 */
const ACCOUNT_COLORS = MAIL_PALETTE.map((swatch) => swatch.hex);

function colorFor(seed: string): string {
    let hash = 0;
    for (let index = 0; index < seed.length; index += 1) {
        hash = (hash * 31 + seed.charCodeAt(index)) | 0;
    }
    return ACCOUNT_COLORS[Math.abs(hash) % ACCOUNT_COLORS.length] ?? ACCOUNT_COLORS[0]!;
}

/**
 * A colour per mailbox, and never the same one twice.
 *
 * The hash above is what keeps a mailbox's colour still when another is added
 * above it, and on its own it is not enough: eight colours and two addresses
 * collide about one time in eight. Two mailboxes sharing a colour is the whole
 * feature not working - a row in a merged list is supposed to say which mailbox
 * it came from, and then it does not.
 *
 * So a collision walks forward to the first colour nobody has. The ones somebody
 * chose are claimed first and the rest are walked in the rail's own order, so
 * the answer does not depend on who asks: a mailbox given a colour keeps it,
 * every other keeps the one it had, and only the mailbox that collided moves -
 * once, as it is added.
 *
 * Past eight mailboxes there is nothing left to move to and the hash stands.
 * Eight dots are already more than anybody tells apart at a glance.
 */
export function coloursFor(
    accounts: readonly { id: string; address: string; color: string | null }[]
): Record<string, string> {
    const taken = new Set(
        accounts.map((account) => account.color).filter((color): color is string => Boolean(color))
    );
    const out: Record<string, string> = {};
    for (const account of accounts) {
        if (account.color) {
            out[account.id] = account.color;
            continue;
        }
        const wanted = colorFor(account.address || account.id);
        let next = wanted;
        if (taken.has(wanted)) {
            const from = ACCOUNT_COLORS.indexOf(wanted);
            for (let step = 1; step < ACCOUNT_COLORS.length; step += 1) {
                const candidate = ACCOUNT_COLORS[(from + step) % ACCOUNT_COLORS.length]!;
                if (taken.has(candidate)) continue;
                next = candidate;
                break;
            }
        }
        out[account.id] = next;
        taken.add(next);
    }
    return out;
}
