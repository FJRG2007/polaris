package polaris.anticheat.platform.neoforge.utils;

import org.slf4j.LoggerFactory;

import java.util.logging.Level;
import java.util.logging.LogRecord;
import java.util.logging.Logger;

/** The engine logs through java.util.logging; the server's log is SLF4J's. As upstream's Fabric platform. */
public final class Slf4jBackedJULogger extends Logger {

    private final org.slf4j.Logger slf4j;

    public Slf4jBackedJULogger(String name) {
        super(name, null);
        this.slf4j = LoggerFactory.getLogger(name);
    }

    @Override
    public void log(LogRecord record) {
        log(record.getLevel(), record.getMessage(), record.getThrown());
    }

    @Override
    public void log(Level level, String msg) {
        log(level, msg, (Throwable) null);
    }

    @Override
    public void log(Level level, String msg, Throwable thrown) {
        int value = level.intValue();
        if (value >= Level.SEVERE.intValue()) {
            slf4j.error(msg, thrown);
        } else if (value >= Level.WARNING.intValue()) {
            slf4j.warn(msg, thrown);
        } else if (value >= Level.INFO.intValue()) {
            slf4j.info(msg, thrown);
        } else if (value >= Level.FINE.intValue()) {
            slf4j.debug(msg, thrown);
        } else {
            slf4j.trace(msg, thrown);
        }
    }
}
