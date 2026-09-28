package polaris.minecraft;

import java.util.ArrayList;
import java.util.List;

/**
 * A command's passwords, read the same way by the plugin and the NeoForge mod.
 *
 * A bare word is everything up to the next space - letters, digits and symbols
 * alike - and a password with a space in it goes in double quotes, with
 * {@code \"} and {@code \\} escaped. Brigadier's own strings are not used on the
 * mod: an unquoted Brigadier string stops at the first symbol, so a password such
 * as {@code Hola!23} was refused by the game before Polaris ever saw it, with an
 * error that says nothing about passwords.
 */
final class PasswordArguments {
    private PasswordArguments() {
    }

    /** The words in {@code line}, or an empty list when a quote is left open. */
    static List<String> split(String line) {
        List<String> words = new ArrayList<>();
        int at = 0;
        while (at < line.length()) {
            char next = line.charAt(at);
            if (next == ' ') {
                at++;
                continue;
            }
            StringBuilder word = new StringBuilder();
            if (next == '"') {
                at++;
                boolean closed = false;
                while (at < line.length()) {
                    char c = line.charAt(at++);
                    if (c == '\\' && at < line.length()) {
                        word.append(line.charAt(at++));
                    } else if (c == '"') {
                        closed = true;
                        break;
                    } else {
                        word.append(c);
                    }
                }
                if (!closed) return List.of();
            } else {
                while (at < line.length() && line.charAt(at) != ' ') word.append(line.charAt(at++));
            }
            words.add(word.toString());
        }
        return words;
    }
}
