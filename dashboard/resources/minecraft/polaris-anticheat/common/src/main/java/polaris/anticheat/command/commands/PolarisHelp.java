package polaris.anticheat.command.commands;

import polaris.anticheat.PolarisAPI;
import polaris.anticheat.command.BuildableCommand;
import polaris.anticheat.platform.api.manager.cloud.CloudPlatformCommandArguments;
import polaris.anticheat.platform.api.sender.Sender;
import polaris.anticheat.utils.anticheat.MessageUtil;
import org.incendo.cloud.CommandManager;
import org.incendo.cloud.context.CommandContext;
import org.incendo.cloud.description.Description;
import org.jetbrains.annotations.NotNull;

public class PolarisHelp implements BuildableCommand {
    @Override
    public void register(CommandManager<Sender> commandManager, CloudPlatformCommandArguments arguments) {
        commandManager.command(
                commandManager.commandBuilder("polarisac", "polarisac")
                        .literal("help", Description.of("Display help information"))
                        .permission("polarisac.help")
                        .handler(this::handleHelp)
        );
    }

    private void handleHelp(@NotNull CommandContext<Sender> context) {
        Sender sender = context.sender();

        for (String string : PolarisAPI.INSTANCE.getConfigManager().getConfig().getStringList("help")) {
            if (string == null) continue;
            string = MessageUtil.replacePlaceholders(sender, string);
            sender.sendMessage(MessageUtil.miniMessage(string));
        }
    }
}
