/**
 * Which Philips air purifier or humidifier can do what, by model.
 *
 * Generated, not written by hand, from Home Assistant's Philips integration
 * (ruaan-deysel/ha-philips-airpurifier, Apache-2.0, commit 0619ee6c8908):
 * `custom_components/philips_airpurifier/device_models.py` for the models and
 * their presets, speeds, switches, lights, humidifiers and the sensors and
 * filters they lack, and `const.py` for the values a light, a child lock and a
 * humidifier take. Every pattern here is the exact set of values that model's
 * entity writes, and that its status has to hold for that preset or speed to be
 * the one running (`PhilipsFan.preset_mode`).
 *
 * A model is looked up as the integration's config flow does: its first nine
 * characters, then those plus the Wi-Fi module's generation, then its first six
 * (`config_flow.async_step_user`).
 *
 * Pure data, server-only by use.
 */

/** One value a status key holds: the first generation speaks strings, the
 *  third numbers, the child lock a boolean. */
export type Value = string | number | boolean;
type Values = Readonly<Record<string, Value>>;

export interface PhilipsModel {
    /** Which of the three key schemes the unit's status uses (`ApiGeneration`). */
    readonly generation: "gen1" | "gen2" | "gen3";
    /** Preset name (Home Assistant's `PresetMode`) to the values that select it. */
    readonly presets: Readonly<Record<string, Values>>;
    /** Fan speed name to the values that select it, slowest first. */
    readonly speeds: Readonly<Record<string, Values>>;
    readonly switches: readonly string[];
    readonly lights: readonly string[];
    readonly humidifiers: readonly string[];
    readonly unavailableFilters: readonly string[];
    readonly unavailableSensors: readonly string[];
    /** For firmware that only pushes its status on a change: the writes that
     *  make it push (`status_nudge`), a transient value and a resting one. */
    readonly nudge: readonly (readonly [string, number])[] | null;
}

export interface PhilipsHumidifier {
    readonly humidity: string;
    readonly power: string;
    readonly on: Value;
    readonly off: Value;
    readonly function: string;
    readonly humidifying: Value;
    readonly idle: Value;
    /** A 2-in-1 unit switched between purifying and humidifying. */
    readonly switch: boolean;
    readonly min: number;
    readonly max: number;
    readonly step: number;
}

/** AC0650, AC0850/11 AWS_Philips_AIR, AC0850/20 AWS_Philips_AIR, AC0850/31 AWS_Philips_AIR, AC0850/41 AWS_Philips_AIR, AC0850/70 AWS_Philips_AIR, AC0850/85 */
const M_AC0650: PhilipsModel = {
    generation: "gen2",
    presets: {
        auto: { "D03-02": "ON", "D03-12": "Auto General" },
        turbo: { "D03-02": "ON", "D03-12": "Turbo" },
        sleep: { "D03-02": "ON", "D03-12": "Sleep" }
    },
    speeds: {
        sleep: { "D03-02": "ON", "D03-12": "Sleep" },
        turbo: { "D03-02": "ON", "D03-12": "Turbo" }
    },
    switches: [],
    lights: [],
    humidifiers: [],
    unavailableFilters: ["D05-13"],
    unavailableSensors: [],
    nudge: null
};

/** AC0850/11 AWS_Philips_AIR_Combo, AC0850/20 AWS_Philips_AIR_Combo, AC0850/31 AWS_Philips_AIR_Combo, AC0850/41 AWS_Philips_AIR_Combo, AC0850/70 AWS_Philips_AIR_Combo, AC0850/81 */
const M_AC0850_11: PhilipsModel = {
    generation: "gen3",
    presets: {
        auto: { D03102: 1, D0310C: 0 },
        turbo: { D03102: 1, D0310C: 18 },
        sleep: { D03102: 1, D0310C: 17 }
    },
    speeds: {
        sleep: { D03102: 1, D0310C: 17 },
        turbo: { D03102: 1, D0310C: 18 }
    },
    switches: [],
    lights: [],
    humidifiers: [],
    unavailableFilters: ["D05-13"],
    unavailableSensors: [],
    nudge: null
};

/** AC0950, AC0951 */
const M_AC0950: PhilipsModel = {
    generation: "gen3",
    presets: {
        auto: { D03102: 1, D0310C: 0 },
        turbo: { D03102: 1, D0310C: 18 },
        medium: { D03102: 1, D0310C: 19 },
        sleep: { D03102: 1, D0310C: 17 }
    },
    speeds: {
        sleep: { D03102: 1, D0310C: 17 },
        medium: { D03102: 1, D0310C: 19 },
        turbo: { D03102: 1, D0310C: 18 }
    },
    switches: ["D03103", "D03130"],
    lights: ["D03105#1"],
    humidifiers: [],
    unavailableFilters: ["D05-13"],
    unavailableSensors: [],
    nudge: null
};

/** AC1214 */
const M_AC1214: PhilipsModel = {
    generation: "gen1",
    presets: {
        auto: { mode: "P" },
        allergen: { mode: "A" },
        night: { mode: "N" },
        speed_1: { mode: "M", om: "1" },
        speed_2: { mode: "M", om: "2" },
        speed_3: { mode: "M", om: "3" },
        turbo: { mode: "M", om: "t" }
    },
    speeds: {
        night: { mode: "N" },
        speed_1: { mode: "M", om: "1" },
        speed_2: { mode: "M", om: "2" },
        speed_3: { mode: "M", om: "3" },
        turbo: { mode: "M", om: "t" }
    },
    switches: ["cl"],
    lights: ["uil", "aqil"],
    humidifiers: [],
    unavailableFilters: [],
    unavailableSensors: [],
    nudge: null
};

/** AC1715 */
const M_AC1715: PhilipsModel = {
    generation: "gen2",
    presets: {
        auto: { "D03-02": "ON", "D03-12": "Auto General" },
        speed_1: { "D03-02": "ON", "D03-12": "Gentle/Speed 1" },
        speed_2: { "D03-02": "ON", "D03-12": "Speed 2" },
        turbo: { "D03-02": "ON", "D03-12": "Turbo" },
        sleep: { "D03-02": "ON", "D03-12": "Sleep" }
    },
    speeds: {
        sleep: { "D03-02": "ON", "D03-12": "Sleep" },
        speed_1: { "D03-02": "ON", "D03-12": "Gentle/Speed 1" },
        speed_2: { "D03-02": "ON", "D03-12": "Speed 2" },
        turbo: { "D03-02": "ON", "D03-12": "Turbo" }
    },
    switches: [],
    lights: ["D03-05"],
    humidifiers: [],
    unavailableFilters: [],
    unavailableSensors: [],
    nudge: null
};

/** AC2210, AC2221, AC3210, AC3220, AC3221, AC4220, AC4221 */
const M_AC2210: PhilipsModel = {
    generation: "gen3",
    presets: {
        auto: { D03102: 1, D0310C: 0 },
        medium: { D03102: 1, D0310C: 19 },
        turbo: { D03102: 1, D0310C: 18 },
        sleep: { D03102: 1, D0310C: 17 }
    },
    speeds: {
        speed_1: { D03102: 1, D0310C: 1 },
        speed_2: { D03102: 1, D0310C: 2 },
        speed_3: { D03102: 1, D0310C: 3 },
        speed_4: { D03102: 1, D0310C: 4 },
        speed_5: { D03102: 1, D0310C: 5 }
    },
    switches: ["D03103", "D03130", "D03180"],
    lights: ["D03105#1"],
    humidifiers: [],
    unavailableFilters: [],
    unavailableSensors: [],
    nudge: null
};

/** AC2729 */
const M_AC2729: PhilipsModel = {
    generation: "gen1",
    presets: {
        auto: { pwr: "1", mode: "P" },
        allergen: { pwr: "1", mode: "A" },
        night: { pwr: "1", mode: "S", om: "s" },
        speed_1: { pwr: "1", mode: "M", om: "1" },
        speed_2: { pwr: "1", mode: "M", om: "2" },
        speed_3: { pwr: "1", mode: "M", om: "3" },
        turbo: { pwr: "1", mode: "M", om: "t" }
    },
    speeds: {
        night: { pwr: "1", mode: "S", om: "s" },
        speed_1: { pwr: "1", mode: "M", om: "1" },
        speed_2: { pwr: "1", mode: "M", om: "2" },
        speed_3: { pwr: "1", mode: "M", om: "3" },
        turbo: { pwr: "1", mode: "M", om: "t" }
    },
    switches: ["cl", "uil"],
    lights: ["uil", "aqil"],
    humidifiers: ["rhset"],
    unavailableFilters: [],
    unavailableSensors: [],
    nudge: null
};

/** AC2889, AC3259 */
const M_AC2889: PhilipsModel = {
    generation: "gen1",
    presets: {
        auto: { pwr: "1", mode: "P" },
        allergen: { pwr: "1", mode: "A" },
        bacteria: { pwr: "1", mode: "B" },
        sleep: { pwr: "1", mode: "M", om: "s" },
        speed_1: { pwr: "1", mode: "M", om: "1" },
        speed_2: { pwr: "1", mode: "M", om: "2" },
        speed_3: { pwr: "1", mode: "M", om: "3" },
        turbo: { pwr: "1", mode: "M", om: "t" }
    },
    speeds: {
        sleep: { pwr: "1", mode: "M", om: "s" },
        speed_1: { pwr: "1", mode: "M", om: "1" },
        speed_2: { pwr: "1", mode: "M", om: "2" },
        speed_3: { pwr: "1", mode: "M", om: "3" },
        turbo: { pwr: "1", mode: "M", om: "t" }
    },
    switches: [],
    lights: ["uil", "aqil"],
    humidifiers: [],
    unavailableFilters: [],
    unavailableSensors: [],
    nudge: null
};

/** AC2936, AC2939, AC2958, AC2959 */
const M_AC2936: PhilipsModel = {
    generation: "gen1",
    presets: {
        auto: { pwr: "1", mode: "AG" },
        sleep: { pwr: "1", mode: "S" },
        gentle: { pwr: "1", mode: "GT" },
        turbo: { pwr: "1", mode: "T" }
    },
    speeds: {
        sleep: { pwr: "1", mode: "S" },
        gentle: { pwr: "1", mode: "GT" },
        turbo: { pwr: "1", mode: "T" }
    },
    switches: ["cl"],
    lights: ["uil", "aqil"],
    humidifiers: [],
    unavailableFilters: [],
    unavailableSensors: [],
    nudge: null
};

/** AC3033, AC3036, AC3039 */
const M_AC3033: PhilipsModel = {
    generation: "gen1",
    presets: {
        auto: { pwr: "1", mode: "AG" },
        sleep: { pwr: "1", mode: "S", om: "s" },
        allergy_sleep: { pwr: "1", mode: "AS", om: "as" },
        speed_1: { pwr: "1", mode: "M", om: "1" },
        speed_2: { pwr: "1", mode: "M", om: "2" },
        turbo: { pwr: "1", mode: "T", om: "t" }
    },
    speeds: {
        sleep: { pwr: "1", mode: "S", om: "s" },
        speed_1: { pwr: "1", mode: "M", om: "1" },
        speed_2: { pwr: "1", mode: "M", om: "2" },
        turbo: { pwr: "1", mode: "T", om: "t" }
    },
    switches: [],
    lights: ["uil", "aqil"],
    humidifiers: [],
    unavailableFilters: [],
    unavailableSensors: [],
    nudge: null
};

/** AC3055, AC3059, AC3854/50, AC3858/50 */
const M_AC3055: PhilipsModel = {
    generation: "gen1",
    presets: {
        auto: { pwr: "1", mode: "AG" },
        sleep: { pwr: "1", mode: "S", om: "s" },
        speed_1: { pwr: "1", mode: "M", om: "1" },
        speed_2: { pwr: "1", mode: "M", om: "2" },
        turbo: { pwr: "1", mode: "T", om: "t" }
    },
    speeds: {
        sleep: { pwr: "1", mode: "S", om: "s" },
        speed_1: { pwr: "1", mode: "M", om: "1" },
        speed_2: { pwr: "1", mode: "M", om: "2" },
        turbo: { pwr: "1", mode: "T", om: "t" }
    },
    switches: [],
    lights: ["uil", "aqil"],
    humidifiers: [],
    unavailableFilters: [],
    unavailableSensors: [],
    nudge: null
};

/** AC3420, AC3421 */
const M_AC3420: PhilipsModel = {
    generation: "gen3",
    presets: {
        auto: { D03102: 1, D0310C: 0 },
        turbo: { D03102: 1, D0310C: 18 },
        medium: { D03102: 1, D0310C: 19 },
        sleep: { D03102: 1, D0310C: 17 }
    },
    speeds: {
        sleep: { D03102: 1, D0310C: 17 },
        medium: { D03102: 1, D0310C: 19 },
        turbo: { D03102: 1, D0310C: 18 }
    },
    switches: ["D03103", "D03130"],
    lights: ["D03105#1"],
    humidifiers: ["D03128#1"],
    unavailableFilters: ["D05-13"],
    unavailableSensors: [],
    nudge: null
};

/** AC3737 */
const M_AC3737: PhilipsModel = {
    generation: "gen3",
    presets: {
        auto: { D03102: 1, D0310A: 2, D0310C: 0 },
        sleep: { D03102: 1, D0310A: 2, D0310C: 17 },
        turbo: { D03102: 1, D0310A: 3, D0310C: 18 }
    },
    speeds: {
        sleep: { D03102: 1, D0310A: 2, D0310C: 17 },
        speed_1: { D03102: 1, D0310A: 2, D0310C: 1 },
        speed_2: { D03102: 1, D0310A: 2, D0310C: 2 },
        turbo: { D03102: 1, D0310A: 3, D0310C: 18 }
    },
    switches: ["D03103"],
    lights: ["D03105"],
    humidifiers: ["D03128#1"],
    unavailableFilters: [],
    unavailableSensors: ["D0310D"],
    nudge: null
};

/** AC3829 */
const M_AC3829: PhilipsModel = {
    generation: "gen1",
    presets: {
        auto: { pwr: "1", mode: "P" },
        allergen: { pwr: "1", mode: "A" },
        sleep: { pwr: "1", mode: "S", om: "s" },
        speed_1: { pwr: "1", mode: "M", om: "1" },
        speed_2: { pwr: "1", mode: "M", om: "2" },
        speed_3: { pwr: "1", mode: "M", om: "3" },
        turbo: { pwr: "1", mode: "M", om: "t" }
    },
    speeds: {
        sleep: { pwr: "1", mode: "S", om: "s" },
        speed_1: { pwr: "1", mode: "M", om: "1" },
        speed_2: { pwr: "1", mode: "M", om: "2" },
        speed_3: { pwr: "1", mode: "M", om: "3" },
        turbo: { pwr: "1", mode: "M", om: "t" }
    },
    switches: ["cl"],
    lights: ["uil", "aqil"],
    humidifiers: ["rhset"],
    unavailableFilters: [],
    unavailableSensors: [],
    nudge: null
};

/** AC3836 */
const M_AC3836: PhilipsModel = {
    generation: "gen1",
    presets: {
        auto: { pwr: "1", mode: "AG", om: "1" },
        sleep: { pwr: "1", mode: "S", om: "s" },
        turbo: { pwr: "1", mode: "T", om: "t" }
    },
    speeds: {
        sleep: { pwr: "1", mode: "S", om: "s" },
        turbo: { pwr: "1", mode: "T", om: "t" }
    },
    switches: [],
    lights: ["uil", "aqil"],
    humidifiers: [],
    unavailableFilters: [],
    unavailableSensors: [],
    nudge: null
};

/** AC3854/51, AC3858/51, AC3858/83, AC3858/86, AC4236 */
const M_AC3854_51: PhilipsModel = {
    generation: "gen1",
    presets: {
        auto: { pwr: "1", mode: "AG" },
        sleep: { pwr: "1", mode: "S", om: "s" },
        allergy_sleep: { pwr: "1", mode: "AS", om: "as" },
        speed_1: { pwr: "1", mode: "M", om: "1" },
        speed_2: { pwr: "1", mode: "M", om: "2" },
        turbo: { pwr: "1", mode: "T", om: "t" }
    },
    speeds: {
        sleep: { pwr: "1", mode: "S", om: "s" },
        speed_1: { pwr: "1", mode: "M", om: "1" },
        speed_2: { pwr: "1", mode: "M", om: "2" },
        turbo: { pwr: "1", mode: "T", om: "t" }
    },
    switches: ["cl"],
    lights: ["uil", "aqil"],
    humidifiers: [],
    unavailableFilters: [],
    unavailableSensors: [],
    nudge: null
};

/** AC4550, AC4558 */
const M_AC4550: PhilipsModel = {
    generation: "gen1",
    presets: {
        auto: { pwr: "1", mode: "AG", om: "a" },
        gas: { pwr: "1", mode: "F", om: "a" },
        pollution: { pwr: "1", mode: "P", om: "a" },
        allergen: { pwr: "1", mode: "A", om: "a" }
    },
    speeds: {
        sleep: { pwr: "1", om: "s" },
        speed_1: { pwr: "1", om: "1" },
        speed_2: { pwr: "1", om: "2" },
        turbo: { pwr: "1", om: "t" }
    },
    switches: ["cl"],
    lights: ["uil", "aqil"],
    humidifiers: [],
    unavailableFilters: [],
    unavailableSensors: [],
    nudge: null
};

/** AC5659, AC5660 */
const M_AC5659: PhilipsModel = {
    generation: "gen1",
    presets: {
        pollution: { pwr: "1", mode: "P" },
        allergen: { pwr: "1", mode: "A" },
        bacteria: { pwr: "1", mode: "B" },
        sleep: { pwr: "1", mode: "M", om: "s" },
        speed_1: { pwr: "1", mode: "M", om: "1" },
        speed_2: { pwr: "1", mode: "M", om: "2" },
        speed_3: { pwr: "1", mode: "M", om: "3" },
        turbo: { pwr: "1", mode: "M", om: "t" }
    },
    speeds: {
        sleep: { pwr: "1", mode: "M", om: "s" },
        speed_1: { pwr: "1", mode: "M", om: "1" },
        speed_2: { pwr: "1", mode: "M", om: "2" },
        speed_3: { pwr: "1", mode: "M", om: "3" },
        turbo: { pwr: "1", mode: "M", om: "t" }
    },
    switches: [],
    lights: ["uil", "aqil"],
    humidifiers: [],
    unavailableFilters: [],
    unavailableSensors: [],
    nudge: null
};

/** AMF765 */
const M_AMF765: PhilipsModel = {
    generation: "gen3",
    presets: {
        auto: { D03102: 1, D0310C: 0 },
        sleep: { D03102: 1, D0310C: 17 },
        turbo: { D03102: 1, D0310C: 18 }
    },
    speeds: {
        speed_1: { D03102: 1, D0310C: 1 },
        speed_2: { D03102: 1, D0310C: 2 },
        speed_3: { D03102: 1, D0310C: 3 },
        speed_4: { D03102: 1, D0310C: 4 },
        speed_5: { D03102: 1, D0310C: 5 },
        speed_6: { D03102: 1, D0310C: 6 },
        speed_7: { D03102: 1, D0310C: 7 },
        speed_8: { D03102: 1, D0310C: 8 },
        speed_9: { D03102: 1, D0310C: 9 },
        speed_10: { D03102: 1, D0310C: 10 }
    },
    switches: ["D03103", "D03130", "D03134", "D03180"],
    lights: ["D0312D"],
    humidifiers: [],
    unavailableFilters: [],
    unavailableSensors: ["D03122"],
    nudge: null
};

/** AMF870 */
const M_AMF870: PhilipsModel = {
    generation: "gen3",
    presets: {
        auto: { D03102: 1, D0310C: 0 },
        sleep: { D03102: 1, D0310C: 17 },
        turbo: { D03102: 1, D0310C: 18 }
    },
    speeds: {
        speed_1: { D03102: 1, D0310C: 1 },
        speed_2: { D03102: 1, D0310C: 2 },
        speed_3: { D03102: 1, D0310C: 3 },
        speed_4: { D03102: 1, D0310C: 4 },
        speed_5: { D03102: 1, D0310C: 5 },
        speed_6: { D03102: 1, D0310C: 6 },
        speed_7: { D03102: 1, D0310C: 7 },
        speed_8: { D03102: 1, D0310C: 8 },
        speed_9: { D03102: 1, D0310C: 9 },
        speed_10: { D03102: 1, D0310C: 10 }
    },
    switches: ["D03103", "D03130", "D03134", "D03180"],
    lights: ["D0312D"],
    humidifiers: [],
    unavailableFilters: [],
    unavailableSensors: [],
    nudge: null
};

/** CX3120 */
const M_CX3120: PhilipsModel = {
    generation: "gen3",
    presets: {
        auto_plus: { D03102: 1, D0310A: 3, D0310C: 0 },
        ventilation: { D03102: 1, D0310A: 1, D0310C: -127 },
        low: { D03102: 1, D0310A: 3, D0310C: 66 },
        medium: { D03102: 1, D0310A: 3, D0310C: 67 },
        high: { D03102: 1, D0310A: 3, D0310C: 65 }
    },
    speeds: {
        low: { D03102: 1, D0310A: 3, D0310C: 66 },
        medium: { D03102: 1, D0310A: 3, D0310C: 67 },
        high: { D03102: 1, D0310A: 3, D0310C: 65 }
    },
    switches: ["D03103"],
    lights: [],
    humidifiers: [],
    unavailableFilters: [],
    unavailableSensors: ["D0310D", "D03122"],
    nudge: null
};

/** CX5120 */
const M_CX5120: PhilipsModel = {
    generation: "gen3",
    presets: {
        auto: { D03102: 1, D0310A: 3, D0310C: 0 },
        ventilation: { D03102: 1, D0310A: 1, D0310C: -127 },
        low: { D03102: 1, D0310A: 3, D0310C: 66 },
        high: { D03102: 1, D0310A: 3, D0310C: 65 }
    },
    speeds: {
        low: { D03102: 1, D0310A: 3, D0310C: 66 },
        high: { D03102: 1, D0310A: 3, D0310C: 65 }
    },
    switches: ["D03130"],
    lights: ["D03105"],
    humidifiers: [],
    unavailableFilters: [],
    unavailableSensors: ["D0310D", "D03122"],
    nudge: null
};

/** CX3550 */
const M_CX3550: PhilipsModel = {
    generation: "gen3",
    presets: {
        speed_1: { D03102: 1, D0310A: 1, D0310C: 1, D0310D: 1 },
        speed_2: { D03102: 1, D0310A: 1, D0310C: 2, D0310D: 2 },
        speed_3: { D03102: 1, D0310A: 1, D0310C: 3, D0310D: 3 },
        natural: { D03102: 1, D0310A: 1, D0310C: -126, D0310D: 1 },
        sleep: { D03102: 1, D0310A: 1, D0310C: 17, D0310D: 2 }
    },
    speeds: {
        speed_1: { D03102: 1, D0310A: 1, D0310C: 1, D0310D: 1 },
        speed_2: { D03102: 1, D0310A: 1, D0310C: 2, D0310D: 2 },
        speed_3: { D03102: 1, D0310A: 1, D0310C: 3, D0310D: 3 }
    },
    switches: ["D03130"],
    lights: [],
    humidifiers: [],
    unavailableFilters: [],
    unavailableSensors: [],
    nudge: null
};

/** CX7550 */
const M_CX7550: PhilipsModel = {
    generation: "gen3",
    presets: {
        auto: { D03102: 1, D0310A: 1, D0310C: 0 },
        sleep: { D03102: 1, D0310A: 1, D0310C: 17 },
        natural: { D03102: 1, D0310A: 1, D0310C: -126 }
    },
    speeds: {
        speed_1: { D03102: 1, D0310A: 1, D0310C: 1 },
        speed_2: { D03102: 1, D0310A: 1, D0310C: 2 },
        speed_3: { D03102: 1, D0310A: 1, D0310C: 3 },
        speed_4: { D03102: 1, D0310A: 1, D0310C: 4 },
        speed_5: { D03102: 1, D0310A: 1, D0310C: 5 },
        speed_6: { D03102: 1, D0310A: 1, D0310C: 6 },
        speed_7: { D03102: 1, D0310A: 1, D0310C: 7 },
        speed_8: { D03102: 1, D0310A: 1, D0310C: 8 },
        speed_9: { D03102: 1, D0310A: 1, D0310C: 9 },
        speed_10: { D03102: 1, D0310A: 1, D0310C: 10 },
        speed_11: { D03102: 1, D0310A: 1, D0310C: 11 },
        speed_12: { D03102: 1, D0310A: 1, D0310C: 82 }
    },
    switches: ["D03130", "D03133"],
    lights: ["D03105#2"],
    humidifiers: [],
    unavailableFilters: [],
    unavailableSensors: ["D0310D", "D03122"],
    nudge: [
        ["D03105#2", 0],
        ["D03105#2", 115]
    ]
};

/** HU1509, HU1510, HU4209/00 */
const M_HU1509: PhilipsModel = {
    generation: "gen3",
    presets: {
        auto: { D03102: 1, D0310C: 0 },
        sleep: { D03102: 1, D0310C: 17 },
        medium: { D03102: 1, D0310C: 19 },
        high: { D03102: 1, D0310C: 65 }
    },
    speeds: {
        sleep: { D03102: 1, D0310C: 17 },
        medium: { D03102: 1, D0310C: 19 },
        high: { D03102: 1, D0310C: 65 }
    },
    switches: ["D03130", "D03134"],
    lights: ["D03105#2"],
    humidifiers: ["D03128#2"],
    unavailableFilters: [],
    unavailableSensors: [],
    nudge: [
        ["D03105#2", 0],
        ["D03105#2", 115]
    ]
};

/** HU5710 */
const M_HU5710: PhilipsModel = {
    generation: "gen3",
    presets: {
        auto: { D03102: 1, D0310C: 0 },
        sleep: { D03102: 1, D0310C: 17 },
        medium: { D03102: 1, D0310C: 19 },
        high: { D03102: 1, D0310C: 65 }
    },
    speeds: {
        sleep: { D03102: 1, D0310C: 17 },
        medium: { D03102: 1, D0310C: 19 },
        high: { D03102: 1, D0310C: 65 }
    },
    switches: ["D03103", "D03130", "D03139", "D03138", "D03134"],
    lights: ["D03105#2"],
    humidifiers: ["D03128#2"],
    unavailableFilters: [],
    unavailableSensors: [],
    nudge: null
};

export const PHILIPS_MODELS: Readonly<Record<string, PhilipsModel>> = {
    AC0650: M_AC0650,
    "AC0850/11 AWS_Philips_AIR": M_AC0650,
    "AC0850/11 AWS_Philips_AIR_Combo": M_AC0850_11,
    "AC0850/20 AWS_Philips_AIR": M_AC0650,
    "AC0850/20 AWS_Philips_AIR_Combo": M_AC0850_11,
    "AC0850/31 AWS_Philips_AIR": M_AC0650,
    "AC0850/31 AWS_Philips_AIR_Combo": M_AC0850_11,
    "AC0850/41 AWS_Philips_AIR": M_AC0650,
    "AC0850/41 AWS_Philips_AIR_Combo": M_AC0850_11,
    "AC0850/70 AWS_Philips_AIR": M_AC0650,
    "AC0850/70 AWS_Philips_AIR_Combo": M_AC0850_11,
    "AC0850/81": M_AC0850_11,
    "AC0850/85": M_AC0650,
    AC0950: M_AC0950,
    AC0951: M_AC0950,
    AC1214: M_AC1214,
    AC1715: M_AC1715,
    AC2210: M_AC2210,
    AC2221: M_AC2210,
    AC2729: M_AC2729,
    AC2889: M_AC2889,
    AC2936: M_AC2936,
    AC2939: M_AC2936,
    AC2958: M_AC2936,
    AC2959: M_AC2936,
    AC3033: M_AC3033,
    AC3036: M_AC3033,
    AC3039: M_AC3033,
    AC3055: M_AC3055,
    AC3059: M_AC3055,
    AC3210: M_AC2210,
    AC3220: M_AC2210,
    AC3221: M_AC2210,
    AC3259: M_AC2889,
    AC3420: M_AC3420,
    AC3421: M_AC3420,
    AC3737: M_AC3737,
    AC3829: M_AC3829,
    AC3836: M_AC3836,
    "AC3854/50": M_AC3055,
    "AC3858/50": M_AC3055,
    "AC3854/51": M_AC3854_51,
    "AC3858/51": M_AC3854_51,
    "AC3858/83": M_AC3854_51,
    "AC3858/86": M_AC3854_51,
    AC4220: M_AC2210,
    AC4221: M_AC2210,
    AC4236: M_AC3854_51,
    AC4550: M_AC4550,
    AC4558: M_AC4550,
    AC5659: M_AC5659,
    AC5660: M_AC5659,
    AMF765: M_AMF765,
    AMF870: M_AMF870,
    CX3120: M_CX3120,
    CX5120: M_CX5120,
    CX3550: M_CX3550,
    CX7550: M_CX7550,
    HU1509: M_HU1509,
    HU1510: M_HU1509,
    "HU4209/00": M_HU1509,
    HU5710: M_HU5710
};

/** `LIGHT_TYPES`: the value a display light is on and off at, by its key. */
export const PHILIPS_LIGHTS: Readonly<Record<string, { on: Value; off: Value }>> = {
    "D03-05": { on: 100, off: 0 },
    D03105: { on: 100, off: 0 },
    "D03105#1": { on: 123, off: 0 },
    "D03105#2": { on: 123, off: 0 },
    D0312D: { on: 100, off: 0 },
    aqil: { on: 100, off: 0 },
    uil: { on: "1", off: "0" }
};

/** `SWITCH_TYPES`, the child lock's two keys: on and off. */
export const PHILIPS_CHILD_LOCKS: Readonly<Record<string, { on: Value; off: Value }>> = {
    cl: { on: true, off: false },
    D03103: { on: 1, off: 0 }
};

/** `HUMIDIFIER_TYPES`: where the target humidity is, its range and step, and how a
 *  2-in-1 unit is switched between purifying and humidifying. */
export const PHILIPS_HUMIDIFIERS: Readonly<Record<string, PhilipsHumidifier>> = {
    "D03128#1": {
        humidity: "D03125",
        power: "D03102",
        on: 1,
        off: 0,
        function: "D0310D",
        humidifying: 1,
        idle: 5,
        switch: false,
        min: 40,
        max: 70,
        step: 10
    },
    "D03128#2": {
        humidity: "D03125",
        power: "D03102",
        on: 1,
        off: 0,
        function: "D03102",
        humidifying: 1,
        idle: 0,
        switch: false,
        min: 30,
        max: 70,
        step: 5
    },
    rhset: {
        humidity: "rh",
        power: "pwr",
        on: "1",
        off: "0",
        function: "func",
        humidifying: "PH",
        idle: "P",
        switch: true,
        min: 40,
        max: 70,
        step: 10
    }
};
