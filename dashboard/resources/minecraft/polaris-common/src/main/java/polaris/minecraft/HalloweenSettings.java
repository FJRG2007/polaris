package polaris.minecraft;

import java.util.Locale;

/**
 * Halloween's extra touches as the dashboard sets them, from
 * {@code polaris season halloween key=value ...} (apps/game-servers'
 * {@code seasonal-halloween.ts} writes the line). Shared by the mod and the
 * plugin, so both read it the same way.
 *
 * Read strictly: amounts are clamped to {@link #MAX_PERCENT}, a key this jar
 * does not know is skipped (a newer dashboard may send more), and a value that
 * is not a whole number leaves that setting off. Nothing here touches a game.
 */
record HalloweenSettings(
        int witchPercent,
        int batPercent,
        boolean treats,
        boolean horseman,
        int trapPercent,
        int bloodKey,
        boolean trickOrTreat,
        boolean phantoms,
        int gravePercent,
        boolean spanish) {

    /** The most any amount takes, in percent of the usual. */
    static final int MAX_PERCENT = 300;

    /** Nothing on: what a jar does before the dashboard has said anything. */
    static final HalloweenSettings OFF = new HalloweenSettings(0, 0, false, false, 0, 0, false, false, 0, false);

    /** The settings in {@code key=value} words; null when there are none to read. */
    static HalloweenSettings parse(String[] words) {
        if (words == null || words.length == 0) return null;
        int witches = 0;
        int bats = 0;
        boolean treats = false;
        boolean horseman = false;
        int traps = 0;
        int blood = 0;
        boolean trick = false;
        boolean phantoms = false;
        int graves = 0;
        boolean spanish = false;
        for (String word : words) {
            int equals = word.indexOf('=');
            if (equals <= 0) return null;
            String key = word.substring(0, equals).toLowerCase(Locale.ROOT);
            String value = word.substring(equals + 1);
            switch (key) {
                case "witches" -> witches = percent(value);
                case "bats" -> bats = percent(value);
                case "treats" -> treats = flag(value);
                case "horseman" -> horseman = flag(value);
                case "traps" -> traps = percent(value);
                case "blood" -> blood = day(value);
                case "trick" -> trick = flag(value);
                case "phantoms" -> phantoms = flag(value);
                case "graves" -> graves = percent(value);
                case "lang" -> spanish = value.equalsIgnoreCase("es");
                default -> {
                    // A key from a newer dashboard: skipped, the rest still read.
                }
            }
        }
        return new HalloweenSettings(witches, bats, treats, horseman, traps, blood, trick, phantoms, graves, spanish);
    }

    private static int whole(String value) {
        if (value.isEmpty() || value.length() > 9) return 0;
        for (int i = 0; i < value.length(); i++) if (!Character.isDigit(value.charAt(i))) return 0;
        return Integer.parseInt(value);
    }

    private static int percent(String value) {
        return Math.min(whole(value), MAX_PERCENT);
    }

    private static boolean flag(String value) {
        return whole(value) == 1;
    }

    /** A {@code yyyymmdd} day, or 0 for none. */
    private static int day(String value) {
        int day = whole(value);
        return day >= 20_000_101 && day <= 99_991_231 ? day : 0;
    }

    /** One of the lines players read, in the server's language. */
    String words(Line line) {
        return spanish ? line.spanish : line.english;
    }

    /** What players read: chat, names over heads, and the lines above the hotbar. */
    enum Line {
        BLOOD_START("A blood night has begun. Monsters are restless and drop double loot until dawn.",
                "Ha salido la luna de sangre. Los monstruos andan inquietos y sueltan botín doble hasta el amanecer."),
        BLOOD_END("The blood night is over.", "La luna de sangre se ha puesto."),
        HORSEMAN("Headless Horseman", "Jinete sin cabeza"),
        TRICK_NAME("Trick or treat!", "¡Truco o trato!"),
        TRICK_ASK("Bring me a pumpkin!", "¡Tráeme una calabaza!"),
        TRICK_TREAT("A treat for you!", "¡Un premio para ti!"),
        TRICK_SCARE("Trick!", "¡Truco!");

        final String english;
        final String spanish;

        Line(String english, String spanish) {
            this.english = english;
            this.spanish = spanish;
        }
    }
}
