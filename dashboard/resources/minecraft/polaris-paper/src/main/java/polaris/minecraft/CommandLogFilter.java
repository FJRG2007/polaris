package polaris.minecraft;

import java.util.regex.Pattern;
import org.apache.logging.log4j.LogManager;
import org.apache.logging.log4j.core.Filter;
import org.apache.logging.log4j.core.LogEvent;
import org.apache.logging.log4j.core.Logger;
import org.apache.logging.log4j.core.filter.AbstractFilter;

/**
 * Keeps passwords out of the server's console and log file.
 *
 * Spigot and Paper write every command a player types to the log before any
 * plugin sees it - "Steve issued server command: /login hunter2" - and the
 * console is something Polaris shows its operators. So the lines for these three
 * commands are dropped at the root logger, the only place left to stop them.
 */
final class CommandLogFilter extends AbstractFilter {
    private static final Pattern PASSWORD_COMMAND = Pattern.compile(
            "issued server command: /(?:polaris:)?(?:login|register|changepassword)(?:\\s|$)",
            Pattern.CASE_INSENSITIVE);

    private static boolean installed;

    private CommandLogFilter() {
        super(Filter.Result.NEUTRAL, Filter.Result.NEUTRAL);
    }

    /** Once per server run; a plugin reload must not stack a second one. */
    static synchronized void install() {
        if (installed) return;
        if (LogManager.getRootLogger() instanceof Logger root) {
            root.addFilter(new CommandLogFilter());
            installed = true;
        }
    }

    @Override
    public Filter.Result filter(LogEvent event) {
        String message = event.getMessage() == null ? null : event.getMessage().getFormattedMessage();
        return message != null && PASSWORD_COMMAND.matcher(message).find() ? Filter.Result.DENY : Filter.Result.NEUTRAL;
    }
}
