package polaris.minecraft;

import java.util.Locale;
import java.util.Set;

/**
 * Christmas and New Year's Eve as the dashboard last told them, with
 * {@code polaris season winter key=value ...}: shared by the NeoForge mod and the
 * Paper plugin, and free of either, so the rules read the same on both.
 *
 * The jar keeps no calendar. The dashboard reads the days on the server's own
 * clock and hands over the day ({@code day}, as yyyymmdd), whether it is
 * Christmas ({@code christmas}), and both midnights as instants ({@code eveat},
 * {@code nyat}, in epoch milliseconds, 0 for none) - so a countdown here lands
 * on the second the players' clocks say midnight. {@code lang} ({@code en} or
 * {@code es}) is the language players read what it says in.
 *
 * Amounts are whole percentages of the usual few (0 is none, at most
 * {@link #MAX_PERCENT}); switches are 1 or 0.
 */
public record WinterPlan(
        int golems, int snow, int reindeer, int elves, int snowmen,
        boolean presents, boolean santa, boolean lights, boolean eve, boolean newYear, boolean sparkles,
        boolean christmas, int day, long eveAt, long newYearAt, boolean spanish) {

    public static final int MAX_PERCENT = 300;
    /** How long after a midnight its celebration may still start: a tick or a restart late. */
    public static final long CELEBRATE_WINDOW_MILLIS = 60_000;
    /** The countdown's length, in seconds. */
    public static final int COUNTDOWN_SECONDS = 10;
    /** How long before New Year's midnight the sparkles start. */
    public static final long SPARKLE_MILLIS = 60 * 60_000L;

    /** Nothing on: the jar before it is told, or after the winter. */
    public static final WinterPlan NONE = new WinterPlan(0, 0, 0, 0, 0,
            false, false, false, false, false, false, false, 0, 0, 0, false);

    /** Items an elf never takes, by id: anything rare, hard-won or one of a kind. */
    private static final Set<String> VALUABLE = Set.of(
            "minecraft:diamond", "minecraft:diamond_block", "minecraft:emerald", "minecraft:emerald_block",
            "minecraft:netherite_ingot", "minecraft:netherite_scrap", "minecraft:netherite_block",
            "minecraft:ancient_debris", "minecraft:gold_ingot", "minecraft:gold_block", "minecraft:raw_gold_block",
            "minecraft:nether_star", "minecraft:beacon", "minecraft:totem_of_undying", "minecraft:elytra",
            "minecraft:enchanted_golden_apple", "minecraft:golden_apple", "minecraft:dragon_egg",
            "minecraft:dragon_head", "minecraft:heart_of_the_sea", "minecraft:echo_shard", "minecraft:trident",
            "minecraft:conduit", "minecraft:shulker_shell", "minecraft:enchanted_book", "minecraft:spawner",
            "minecraft:trial_key", "minecraft:ominous_trial_key", "minecraft:heavy_core", "minecraft:mace",
            "minecraft:wither_skeleton_skull", "minecraft:lapis_block", "minecraft:experience_bottle",
            "minecraft:name_tag", "minecraft:saddle", "minecraft:music_disc_pigstep", "minecraft:recovery_compass");

    /**
     * The settings on a line, after {@code polaris season winter}. Every key must be
     * known and every value in range; a line with anything else is refused whole,
     * so a newer dashboard never half-configures an older jar.
     */
    public static WinterPlan parse(String[] tokens) {
        int golems = 0, snow = 0, reindeer = 0, elves = 0, snowmen = 0, day = 0;
        boolean presents = false, santa = false, lights = false, eve = false, newYear = false;
        boolean sparkles = false, christmas = false, spanish = false;
        long eveAt = 0, newYearAt = 0;
        for (String token : tokens) {
            if (token.isEmpty()) continue;
            int equals = token.indexOf('=');
            if (equals <= 0) throw new IllegalArgumentException("Not key=value: " + token);
            String key = token.substring(0, equals).toLowerCase(Locale.ROOT);
            String value = token.substring(equals + 1);
            switch (key) {
                case "golems" -> golems = percent(value);
                case "snow" -> snow = percent(value);
                case "reindeer" -> reindeer = percent(value);
                case "elves" -> elves = percent(value);
                case "snowmen" -> snowmen = percent(value);
                case "presents" -> presents = flag(value);
                case "santa" -> santa = flag(value);
                case "lights" -> lights = flag(value);
                case "eve" -> eve = flag(value);
                case "newyear" -> newYear = flag(value);
                case "sparkles" -> sparkles = flag(value);
                case "christmas" -> christmas = flag(value);
                case "day" -> day = dayOf(value);
                case "eveat" -> eveAt = instant(value);
                case "nyat" -> newYearAt = instant(value);
                case "lang" -> spanish = language(value);
                default -> throw new IllegalArgumentException("Unknown setting: " + key);
            }
        }
        return new WinterPlan(golems, snow, reindeer, elves, snowmen,
                presents, santa, lights, eve, newYear, sparkles, christmas, day, eveAt, newYearAt, spanish);
    }

    private static int percent(String value) {
        int parsed = Integer.parseInt(value);
        if (parsed < 0 || parsed > MAX_PERCENT) throw new IllegalArgumentException("Out of range: " + value);
        return parsed;
    }

    private static boolean flag(String value) {
        if (value.equals("1")) return true;
        if (value.equals("0")) return false;
        throw new IllegalArgumentException("Not 0 or 1: " + value);
    }

    private static int dayOf(String value) {
        int parsed = Integer.parseInt(value);
        if (parsed != 0 && (parsed < 2000_01_01 || parsed > 2999_12_31)) throw new IllegalArgumentException("Not a day: " + value);
        return parsed;
    }

    private static boolean language(String value) {
        if (value.equals("es")) return true;
        if (value.equals("en")) return false;
        throw new IllegalArgumentException("Not a language: " + value);
    }

    private static long instant(String value) {
        long parsed = Long.parseLong(value);
        if (parsed < 0) throw new IllegalArgumentException("Not an instant: " + value);
        return parsed;
    }

    /** Presents, Santa and the elves: on, and Christmas on the server's clock. */
    public boolean presentsNow() {
        return presents && christmas;
    }

    public boolean santaNow() {
        return santa && christmas;
    }

    public boolean elvesNow() {
        return elves > 0 && christmas;
    }

    /**
     * How many of something are kept near one player: the usual few scaled by a
     * percentage, never more than three times as many, and at least one for any
     * setting above none.
     */
    public static int cap(int usual, int percent) {
        if (percent <= 0 || usual <= 0) return 0;
        int bounded = Math.min(percent, MAX_PERCENT);
        return Math.max(1, Math.round(usual * bounded / 100f));
    }

    /**
     * The second of the countdown showing at {@code now}, 10 down to 1, or 0 when
     * no countdown is running: before its last ten seconds, after midnight, or
     * with no midnight given.
     */
    public static int countdown(long now, long midnight) {
        if (midnight <= 0) return 0;
        long left = midnight - now;
        if (left <= 0 || left > COUNTDOWN_SECONDS * 1000L) return 0;
        return (int) ((left + 999) / 1000);
    }

    /** Whether a midnight has come and its celebration may still start. */
    public static boolean celebrating(long now, long midnight) {
        return midnight > 0 && now >= midnight && now - midnight < CELEBRATE_WINDOW_MILLIS;
    }

    /** Whether it is the last hour before a midnight. */
    public static boolean lastHour(long now, long midnight) {
        return midnight > 0 && now < midnight && midnight - now <= SPARKLE_MILLIS;
    }

    /** Whether an elf may never take this item, by its id. */
    public static boolean valuable(String itemId) {
        return VALUABLE.contains(itemId);
    }

    /** One of the lines players read, in the server's language; {@code %s} is where a name goes. */
    public String words(Line line) {
        return spanish ? line.spanish : line.english;
    }

    /** What players read: chat, titles, and the names over heads and on presents. */
    public enum Line {
        SNOWMAN("Grumpy Snowman", "Muñeco gruñón"),
        REINDEER("Reindeer", "Reno"),
        SANTA("Santa", "Papá Noel"),
        SANTA_VISITS("Santa is visiting your home tonight. He trades until sunrise.",
                "Papá Noel visita tu casa esta noche. Comercia hasta el amanecer."),
        ELF("Elf", "Elfo"),
        ELF_FOUND_NOTHING("An elf rummaged through your pockets and found nothing it wanted.",
                "Un elfo ha rebuscado en tus bolsillos y no ha encontrado nada que quisiera."),
        ELF_STOLE("An elf stole your %s! Catch it to get it back.",
                "¡Un elfo te ha robado: %s! Atrápalo para recuperarlo."),
        ELF_NEEDS_ROOM("An elf is waiting to give back your %s. Make room in your inventory.",
                "Un elfo espera para devolverte: %s. Haz sitio en tu inventario."),
        ELF_GAVE_BACK("You got your %s back from the elf.", "El elfo te ha devuelto: %s."),
        PRESENT_FOR("Present for %s", "Regalo para %s"),
        PRESENT_WAITING("A present is waiting for you under a tree nearby.",
                "Te espera un regalo bajo un árbol cercano."),
        NEW_YEAR_SOON("The New Year is ten seconds away!", "¡Quedan diez segundos para el Año Nuevo!"),
        NEW_YEAR("Happy New Year!", "¡Feliz Año Nuevo!"),
        NEW_YEAR_GIFT("A small gift is in your inventory", "Tienes un pequeño regalo en el inventario"),
        NEW_YEAR_ALL("Happy New Year, everyone!", "¡Feliz Año Nuevo a todos!"),
        CHRISTMAS("Merry Christmas!", "¡Feliz Navidad!"),
        CHRISTMAS_GIFT("A gift is in your inventory", "Tienes un regalo en el inventario"),
        CHRISTMAS_ALL("It is midnight on Christmas Eve. Merry Christmas, everyone!",
                "Es medianoche en Nochebuena. ¡Feliz Navidad a todos!");

        final String english;
        final String spanish;

        Line(String english, String spanish) {
            this.english = english;
            this.spanish = spanish;
        }
    }
}
