package polaris.minecraft;

import java.util.Locale;

/**
 * Which language one player reads a seasonal line in. Spanish when their
 * client reports a Spanish locale ({@code es_es}, {@code es_mx}, ...), English
 * for any other one, and the server's {@code lang} setting when the client has
 * not reported a locale at all. Shared by the mod and the plugin.
 */
public final class PlayerLanguage {

    private PlayerLanguage() {
    }

    /** True when a player whose client reports {@code clientLocale} reads Spanish. */
    public static boolean spanish(String clientLocale, boolean serverSpanish) {
        if (clientLocale == null || clientLocale.isBlank()) return serverSpanish;
        return clientLocale.trim().toLowerCase(Locale.ROOT).startsWith("es");
    }
}
