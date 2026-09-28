package polaris.anticheat.manager.init.start;

import polaris.anticheat.platform.api.command.CommandService;
import polaris.anticheat.utils.anticheat.LogUtil;

public record CommandRegister(CommandService service) implements StartableInitable {

    @Override
    public void start() {
        try {
            if (service != null) {
                service.registerCommands();
            }
        } catch (RuntimeException t) {
            // This is the ultimate safety net. If command registration fails, Polaris keeps running.
            LogUtil.error("Failed to register commands! Polaris will run without command support.", t);
        }
    }
}
