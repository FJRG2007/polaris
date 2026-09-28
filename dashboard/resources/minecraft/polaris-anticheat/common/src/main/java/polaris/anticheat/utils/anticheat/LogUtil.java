package polaris.anticheat.utils.anticheat;

import polaris.anticheat.PolarisAPI;
import lombok.experimental.UtilityClass;
import net.kyori.adventure.text.Component;

import java.io.PrintWriter;
import java.io.StringWriter;
import java.util.logging.Logger;

@UtilityClass
public class LogUtil {
    public void info(final String info) {
        getLogger().info(info);
    }

    public void warn(final String warn) {
        getLogger().warning(warn);
    }

    @SuppressWarnings("CallToPrintStackTrace")
    public void warn(final String description, final Throwable throwable) {
        Logger logger = getLogger();
        if (logger != null) {
            logger.warning(description + ": " + getStackTrace(throwable));
        } else {
            throwable.printStackTrace();
        }
    }

    public void error(final String error) {
        getLogger().severe(error);
    }

    @SuppressWarnings("CallToPrintStackTrace")
    public void error(final String description, final Throwable throwable) {
        Logger logger = getLogger();
        if (logger != null) {
            logger.severe(description + ": " + getStackTrace(throwable));
        } else {
            throwable.printStackTrace();
        }
    }

    @SuppressWarnings("CallToPrintStackTrace")
    public void error(final Throwable throwable) {
        Logger logger = getLogger();
        if (logger != null) {
            logger.severe(getStackTrace(throwable));
        } else {
            throwable.printStackTrace();
        }
    }

    public Logger getLogger() {
        return PolarisAPI.INSTANCE.getPolarisPlugin().getLogger();
    }

    public void console(final String info) {
        PolarisAPI.INSTANCE.getPlatformServer().getConsoleSender().sendMessage(MessageUtil.translateAlternateColorCodes('&', info));
    }

    public void console(final Component info) {
        PolarisAPI.INSTANCE.getPlatformServer().getConsoleSender().sendMessage(info);
    }

    private static String getStackTrace(Throwable throwable) {
        String message = throwable.getMessage();
        try (StringWriter sw = new StringWriter()) {
            try (PrintWriter pw = new PrintWriter(sw)) {
                throwable.printStackTrace(pw);
                message = sw.toString();
            }
        } catch (Exception ignored) {
        }
        return message;
    }

}
