package polaris.minecraft;

import java.util.ArrayList;
import java.util.List;

/**
 * A command's arguments, read the way the NeoForge mod reads them.
 *
 * Bukkit splits a command on spaces, so a password with a space in it would
 * arrive as two arguments. The mod takes Brigadier strings instead - a bare word,
 * or anything in double quotes with {@code \"} and {@code \\} escaped - and the
 * players of both are told the same thing, so this reads the same.
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
