package polaris.anticheat.command.commands;

import polaris.anticheat.PolarisAPI;
import polaris.anticheat.command.BuildableCommand;
import polaris.anticheat.platform.api.manager.cloud.CloudPlatformCommandArguments;
import polaris.anticheat.platform.api.sender.Sender;
import polaris.anticheat.utils.anticheat.MessageUtil;
import net.kyori.adventure.text.Component;
import org.incendo.cloud.CommandManager;
import org.incendo.cloud.context.CommandContext;
import org.jetbrains.annotations.NotNull;

public class PolarisReload implements BuildableCommand {
    @Override
    public void register(CommandManager<Sender> commandManager, CloudPlatformCommandArguments arguments) {
        commandManager.command(
                commandManager.commandBuilder("polarisac", "polarisac")
                        .literal("reload")
                        .permission("polarisac.reload")
                        .handler(this::handleReload)
        );
    }

    private void handleReload(@NotNull CommandContext<Sender> context) {
        Sender sender = context.sender();

        // reload config
        sender.sendMessage(MessageUtil.getParsedComponent(sender, "reloading", "%prefix% &7Reloading config..."));

        PolarisAPI.INSTANCE.getExternalAPI().reloadAsync().exceptionally(throwable -> false)
                .thenAccept(bool -> {
                    Component message = bool
                            ? MessageUtil.getParsedComponent(sender, "reloaded", "%prefix% &fConfig has been reloaded.")
                            : MessageUtil.getParsedComponent(sender, "reload-failed", "%prefix% &cFailed to reload config.");
                    sender.sendMessage(message);
                });
    }
}
