"use client";

/**
 * Making up a password, or a passphrase.
 *
 * The reason a vault is worth having is that nothing in it has to be memorable,
 * so this is not a garnish - it is how most items get their password. It draws
 * from `crypto.getRandomValues` rather than `Math.random`, and it rejects the
 * modulo shortcut that would quietly favour the first characters of the
 * alphabet.
 *
 * Passphrases are here for the handful of passwords a person still has to type
 * by hand - a disk, a phone, the vault itself - where four random words beat
 * sixteen random characters nobody can read off a screen.
 */

import { Button, Input, Select } from "@polaris/ui";
import { Check, Copy, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

const LOWER = "abcdefghijkmnopqrstuvwxyz";
const UPPER = "ABCDEFGHJKLMNPQRSTUVWXYZ";
const DIGITS = "23456789";
const SYMBOLS = "!@#$%^&*()-_=+[]{};:,.?";

/**
 * A short word list, for passphrases.
 *
 * Deliberately not a full diceware list: those are thousands of entries, and
 * shipping one to every browser that opens the vault costs more than the extra
 * entropy is worth here. Four words from 256 is 32 bits, and the length is
 * adjustable for anybody who wants more.
 */
const WORDS =
    "able acid aged also area army away baby back ball band bank base bath bear beat been beer bell belt bend best bike bind bird bite blue boat body bold bone book boot born boss both bowl bulk bull burn bush busy cake call calm came camp card care case cash cast cell chat chef chip city club coal coat code cold come cook cool cope copy core corn cost crew crop dark data date dawn days dead deal dear debt deep deer dent desk dial diet dirt dish disk dock does dome done door dose down draw drew drop drum dual duck dust duty each earn ease east easy edge else even ever exit face fact fade fail fair fall fame farm fast fate fear feed feel feet fell felt file fill film find fine fire firm fish five flag flat flew flow foam fold folk font food foot ford form fort four free from fuel full fund gain game gate gave gear gene gift girl give glad glow goal goat goes gold golf gone good gray grew grid grim grow gulf hair half hall hand hang hard harm hate have hawk head heal heap hear heat held hell helm help herb herd here hero hide high hill hint hire hold hole holy home hood hook hope horn host hour huge hunt hurt icon idea inch iron item jazz join jump jury just keen keep kept kick kind king kiss kite knee knew knot know lace lack lady laid lake lamb lamp land lane last late lawn lead leaf lean leap left lend lens less lift like limb lime line link lion list live load loan lock loft logo long look loop lord lose loss lost loud love luck lung made mail main make male mall many mark mask mass mast mate math meal mean meat meet melt menu mere mesh mice mild mile milk mill mind mine mint miss mist mode mood moon more moss most move much must name navy near neat neck need nest news next nice node none noon norm nose note noun oath obey odds okay omit once only onto open oral oven over pace pack page paid pain pair pale palm park part pass past path peak pear peer pick pile pine pink pipe pity plan play plot plug plus poem poet pole poll pond pool poor pope port pose post pour pray prep prey pull pure push quit race rack raft rage rail rain rank rare rate read real reef rely rent rest rice rich ride ring rise risk road robe rock rode role roll roof room root rope rose rule rush rust safe sail sale salt same sand save scan seal seat seed seek seem seen self sell send sent ship shoe shop shot show shut side sign silk sing sink site size skin skip slab slam slid slip slow snap snow soap sock soft soil sold sole solo song soon sort soul soup spin spot star stay stem step stir stop such suit sung sure swim tail take tale talk tall tank tape task team tear tech tell tend tent term test text than that thaw them then they thin this thus tide tidy tile till time tiny tire toad toll tone took tool torn tour town trap tray tree trim trio trip true tube tune turn twin type unit upon urge used user vast vein verb very vibe view vine visa void vote wage wait wake walk wall want ward warm warn wash wave weak wear weed week well went were west what when whom wide wife wild will wind wine wing wipe wire wise wish with wolf wood wool word wore work worm worn wrap yard yarn yeah year your zero zone zoom".split(
        " "
    );

/** A random integer below `bound`, without the bias a plain modulo introduces. */
function randomBelow(bound: number): number {
    const limit = Math.floor(0xffffffff / bound) * bound;
    const buffer = new Uint32Array(1);
    let value = 0;
    do {
        crypto.getRandomValues(buffer);
        value = buffer[0]!;
        // The tail above the last whole multiple is thrown away rather than
        // folded in, which is the difference between uniform and nearly uniform.
    } while (value >= limit);
    return value % bound;
}

function pick(alphabet: string): string {
    return alphabet[randomBelow(alphabet.length)]!;
}

export interface GeneratorOptions {
    kind: "password" | "passphrase";
    length: number;
    upper: boolean;
    digits: boolean;
    symbols: boolean;
    separator: string;
}

const DEFAULTS: GeneratorOptions = {
    kind: "password",
    length: 20,
    upper: true,
    digits: true,
    symbols: true,
    separator: "-"
};

/** Make one, to the given shape. */
export function generate(options: GeneratorOptions): string {
    if (options.kind === "passphrase") {
        const count = Math.max(3, Math.min(10, options.length));
        const words: string[] = [];
        for (let index = 0; index < count; index += 1) {
            const word = WORDS[randomBelow(WORDS.length)]!;
            words.push(options.upper ? word[0]!.toUpperCase() + word.slice(1) : word);
        }
        if (options.digits) {
            words[randomBelow(words.length)] += String(randomBelow(100)).padStart(2, "0");
        }
        return words.join(options.separator || "-");
    }

    const alphabets = [LOWER];
    if (options.upper) alphabets.push(UPPER);
    if (options.digits) alphabets.push(DIGITS);
    if (options.symbols) alphabets.push(SYMBOLS);
    const pool = alphabets.join("");
    const length = Math.max(8, Math.min(128, options.length));

    // One character from each chosen set first, so "include digits" means the
    // result has one rather than probably having one.
    const characters = alphabets.map(pick);
    while (characters.length < length) characters.push(pick(pool));
    // Shuffled, or the first characters would always be one per set in order.
    for (let index = characters.length - 1; index > 0; index -= 1) {
        const swap = randomBelow(index + 1);
        [characters[index], characters[swap]] = [characters[swap]!, characters[index]!];
    }
    return characters.join("");
}

export function PasswordGenerator({ onUse }: { onUse?: (value: string) => void }) {
    const [options, setOptions] = useState<GeneratorOptions>(DEFAULTS);
    const [value, setValue] = useState("");
    const [copied, setCopied] = useState(false);

    const roll = useCallback(() => {
        setValue(generate(options));
        setCopied(false);
    }, [options]);

    useEffect(() => roll(), [roll]);

    return (
        <div className="flex flex-col gap-3">
            <div className="flex items-center gap-2">
                <Input
                    readOnly
                    value={value}
                    className="font-mono text-sm"
                    aria-label="Generated"
                />
                <Button
                    type="button"
                    size="icon"
                    variant="secondary"
                    title="Generate another"
                    aria-label="Generate another"
                    onClick={roll}
                >
                    <RefreshCw className="size-4" />
                </Button>
                <Button
                    type="button"
                    size="icon"
                    variant="secondary"
                    title="Copy"
                    aria-label="Copy the generated value"
                    onClick={async () => {
                        await navigator.clipboard.writeText(value);
                        setCopied(true);
                    }}
                >
                    {copied ? (
                        <Check className="size-4 text-success" />
                    ) : (
                        <Copy className="size-4" />
                    )}
                </Button>
            </div>

            <div className="grid grid-cols-2 gap-3">
                <label className="flex flex-col gap-1 text-sm">
                    Kind
                    <Select
                        value={options.kind}
                        onValueChange={(kind) =>
                            setOptions((prev) => ({
                                ...prev,
                                kind: kind as GeneratorOptions["kind"],
                                length: kind === "passphrase" ? 4 : 20
                            }))
                        }
                        options={[
                            { value: "password", label: "Password" },
                            { value: "passphrase", label: "Passphrase" }
                        ]}
                        aria-label="Kind"
                    />
                </label>
                <label className="flex flex-col gap-1 text-sm">
                    {options.kind === "passphrase" ? "Words" : "Length"}
                    <Input
                        type="number"
                        min={options.kind === "passphrase" ? 3 : 8}
                        max={options.kind === "passphrase" ? 10 : 128}
                        value={options.length}
                        onChange={(event) =>
                            setOptions((prev) => ({ ...prev, length: Number(event.target.value) }))
                        }
                    />
                </label>
            </div>

            <div className="flex flex-wrap gap-4 text-sm">
                <label className="flex items-center gap-2">
                    <input
                        type="checkbox"
                        className="size-4"
                        checked={options.upper}
                        onChange={(event) =>
                            setOptions((prev) => ({ ...prev, upper: event.target.checked }))
                        }
                    />
                    {options.kind === "passphrase" ? "Capitalize" : "A-Z"}
                </label>
                <label className="flex items-center gap-2">
                    <input
                        type="checkbox"
                        className="size-4"
                        checked={options.digits}
                        onChange={(event) =>
                            setOptions((prev) => ({ ...prev, digits: event.target.checked }))
                        }
                    />
                    {options.kind === "passphrase" ? "A number" : "0-9"}
                </label>
                {options.kind === "password" ? (
                    <label className="flex items-center gap-2">
                        <input
                            type="checkbox"
                            className="size-4"
                            checked={options.symbols}
                            onChange={(event) =>
                                setOptions((prev) => ({ ...prev, symbols: event.target.checked }))
                            }
                        />
                        Symbols
                    </label>
                ) : null}
            </div>

            {onUse ? (
                <div className="flex justify-end">
                    <Button type="button" onClick={() => onUse(value)}>
                        Use this
                    </Button>
                </div>
            ) : null}
        </div>
    );
}
