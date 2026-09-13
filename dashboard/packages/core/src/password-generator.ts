/**
 * Making up a password, uniformly.
 *
 * Here rather than in the extension because the web vault wants the same thing
 * and two generators would drift: one of them would end up with the bias below
 * and nobody would notice, because a biased password looks exactly like an
 * unbiased one.
 *
 * **The bias worth avoiding.** `getRandomValues() % alphabet.length` is the
 * obvious way and it is wrong: unless the alphabet divides 2^32 exactly, the
 * first few characters of the alphabet come up slightly more often than the
 * rest. It is small, it is invisible, and it is free to avoid - draw again when a
 * value lands in the short tail, which is what `pick` does.
 *
 * **Minimums are placed, then shuffled.** Asking for two digits by generating
 * until a password happens to have two is a loop with no bound; putting them at
 * known positions is a password whose shape is known. So the required characters
 * are drawn first and the whole thing is shuffled with the same uniform picker.
 *
 * There is no passphrase generator here, deliberately: a passphrase needs a real
 * word list - EFF's is 7,776 words - and a list invented to fill the gap would be
 * a small dictionary masquerading as a large one. It is a data file to add on
 * purpose, not something to improvise.
 *
 * Works anywhere `crypto.getRandomValues` does, which is every browser and every
 * Node this repository runs.
 */

/** What the password may be made of, and how long. */
export interface PasswordWanted {
    readonly length: number;
    readonly lowercase: boolean;
    readonly uppercase: boolean;
    readonly digits: boolean;
    readonly symbols: boolean;
    /** At least this many digits, if digits are allowed at all. */
    readonly minDigits?: number;
    /** At least this many symbols, if symbols are allowed at all. */
    readonly minSymbols?: number;
    /**
     * Leave out the characters people misread to each other.
     *
     * Costs a little entropy and buys a password somebody can copy off a screen
     * onto a games console without three attempts, which is the trade most people
     * would make knowingly.
     */
    readonly avoidAmbiguous?: boolean;
}

/** What a generator offers when nobody has said otherwise. */
export const PASSWORD_DEFAULTS: PasswordWanted = {
    length: 20,
    lowercase: true,
    uppercase: true,
    digits: true,
    symbols: true,
    minDigits: 1,
    minSymbols: 1,
    avoidAmbiguous: false
};

/** The shortest and longest this will make. */
export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 128;

const LOWER = "abcdefghijklmnopqrstuvwxyz";
const UPPER = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const DIGITS = "0123456789";
/** Punctuation a password field accepts everywhere. Deliberately not the whole
 *  of ASCII: a quote or a backslash is the one that breaks somebody's form. */
const SYMBOLS = "!#$%&*+-=?@^_";
/** The ones that read as each other in most fonts. */
const AMBIGUOUS = new Set(["l", "I", "O", "o", "0", "1"]);

function alphabet(source: string, avoidAmbiguous: boolean): string {
    return avoidAmbiguous
        ? [...source].filter((character) => !AMBIGUOUS.has(character)).join("")
        : source;
}

/**
 * One number below `ceiling`, every value equally likely.
 *
 * Draws again rather than taking a remainder: values in the final, short stretch
 * of the 32-bit range are discarded, so nothing in the alphabet is favoured. The
 * loop ends - each draw has at least a 50% chance of being inside the range for
 * any ceiling this is called with.
 */
function pick(ceiling: number): number {
    if (ceiling <= 0) return 0;
    const limit = Math.floor(0x1_0000_0000 / ceiling) * ceiling;
    const slot = new Uint32Array(1);
    for (;;) {
        crypto.getRandomValues(slot);
        const drawn = slot[0] as number;
        if (drawn < limit) return drawn % ceiling;
    }
}

function some(source: string, count: number): string[] {
    return Array.from({ length: count }, () => source[pick(source.length)] as string);
}

/** In place, with the same uniform draw: a shuffle is only as good as its source. */
function shuffle(characters: string[]): void {
    for (let at = characters.length - 1; at > 0; at -= 1) {
        const other = pick(at + 1);
        const held = characters[at] as string;
        characters[at] = characters[other] as string;
        characters[other] = held;
    }
}

/**
 * A password, or null when what was asked for cannot be made.
 *
 * Null rather than a thrown error or a quiet substitution: "twelve characters, at
 * least eight digits and eight symbols" is a contradiction somebody typed, and
 * the answer is to say so on the form rather than to hand back something that
 * does not honour it.
 */
export function generatePassword(wanted: Partial<PasswordWanted> = {}): string | null {
    const want = { ...PASSWORD_DEFAULTS, ...wanted };
    const avoid = want.avoidAmbiguous === true;

    const pools = [
        { on: want.lowercase, characters: alphabet(LOWER, avoid), least: 0 },
        { on: want.uppercase, characters: alphabet(UPPER, avoid), least: 0 },
        { on: want.digits, characters: alphabet(DIGITS, avoid), least: want.minDigits ?? 0 },
        { on: want.symbols, characters: SYMBOLS, least: want.minSymbols ?? 0 }
    ].filter((pool) => pool.on && pool.characters !== "");

    const length = Math.trunc(want.length);
    if (pools.length === 0) return null;
    if (length < PASSWORD_MIN_LENGTH || length > PASSWORD_MAX_LENGTH) return null;

    const required = pools.reduce((total, pool) => total + pool.least, 0);
    if (required > length) return null;

    const characters = pools.flatMap((pool) => some(pool.characters, pool.least));
    const everything = pools.map((pool) => pool.characters).join("");
    characters.push(...some(everything, length - characters.length));
    shuffle(characters);
    return characters.join("");
}
