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

    private static CommandLogFilter active;

    private CommandLogFilter() {
        super(Filter.Result.NEUTRAL, Filter.Result.NEUTRAL);
    }

    /** One at a time; {@link #uninstall()} takes it off again before a reload loads a new copy. */
    static synchronized void install() {
        if (active != null) return;
        if (LogManager.getRootLogger() instanceof Logger root) {
            active = new CommandLogFilter();
            root.addFilter(active);
        }
    }

    static synchronized void uninstall() {
        if (active == null) return;
        if (LogManager.getRootLogger() instanceof Logger root) {
            root.getContext().getConfiguration().getRootLogger().removeFilter(active);
        }
        active = null;
    }

    @Override
    public Filter.Result filter(LogEvent event) {
        String message = event.getMessage() == null ? null : event.getMessage().getFormattedMessage();
        return message != null && PASSWORD_COMMAND.matcher(message).find() ? Filter.Result.DENY : Filter.Result.NEUTRAL;
    }
}
