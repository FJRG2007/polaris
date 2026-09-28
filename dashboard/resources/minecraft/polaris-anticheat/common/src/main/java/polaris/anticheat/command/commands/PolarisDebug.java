package polaris.anticheat.command.commands;

import polaris.anticheat.PolarisAPI;
import polaris.anticheat.command.BuildableCommand;
import polaris.anticheat.platform.api.command.PlayerSelector;
import polaris.anticheat.platform.api.manager.cloud.CloudPlatformCommandArguments;
import polaris.anticheat.platform.api.sender.Sender;
import polaris.anticheat.player.PolarisPlayer;
import polaris.anticheat.utils.anticheat.MessageUtil;
import com.github.retrooper.packetevents.PacketEvents;
import com.github.retrooper.packetevents.protocol.player.User;
import net.kyori.adventure.text.Component;
import net.kyori.adventure.text.format.NamedTextColor;
import org.incendo.cloud.Command;
import org.incendo.cloud.CommandManager;
import org.incendo.cloud.context.CommandContext;
import org.incendo.cloud.description.Description;
import org.jetbrains.annotations.NotNull;
import org.jetbrains.annotations.Nullable;

public class PolarisDebug implements BuildableCommand {

    public void register(CommandManager<Sender> commandManager, CloudPlatformCommandArguments arguments) {
        Command.Builder<Sender> polarisacCommand = commandManager.commandBuilder("polarisac", "polarisac");

        // Register "debug" subcommand
        Command.Builder<Sender> debugCommand = polarisacCommand
                .literal("debug", Description.of("Toggle debug output for a player"))
                .permission("polarisac.debug")
                .optional("target", arguments.singlePlayerSelectorParser())
                .handler(this::handleDebug);

        // Register "consoledebug" subcommand
        Command.Builder<Sender> consoleDebugCommand = polarisacCommand
                .literal("consoledebug", Description.of("Toggle console debug output for a player"))
                .permission("polarisac.consoledebug")
                .required("target", arguments.singlePlayerSelectorParser())
                .handler(this::handleConsoleDebug);

        // Register command
        commandManager.command(debugCommand);
        commandManager.command(consoleDebugCommand);
    }

    private void handleDebug(@NotNull CommandContext<Sender> context) {
        Sender sender = context.sender();
        PlayerSelector playerSelector = context.getOrDefault("target", null);

        PolarisPlayer targetPolarisPlayer = parseTarget(sender, playerSelector == null ? sender : playerSelector.getSinglePlayer());
        if (targetPolarisPlayer == null) {
            sender.sendMessage(MessageUtil.getParsedComponent(sender, "player-not-found", "%prefix% &cPlayer is exempt or offline!"));
            return;
        }

        if (sender.isConsole()) {
            targetPolarisPlayer.checkManager.getDebugHandler().toggleConsoleOutput();
        } else if (sender.isPlayer()) {
            PolarisPlayer senderPolarisPlayer = PolarisAPI.INSTANCE.getPlayerDataManager().getPlayer(sender.getUniqueId());
            if (senderPolarisPlayer == null) {
                sender.sendMessage(MessageUtil.getParsedComponent(sender, "sender-not-found", "%prefix% &cYou cannot be exempt to use this command!"));
                return;
            }
            targetPolarisPlayer.checkManager.getDebugHandler().toggleListener(senderPolarisPlayer);
        } else {
            sender.sendMessage(MessageUtil.getParsedComponent(sender,
                    "run-as-player-or-console",
                    "%prefix% &cThis command can only be used by players or the console!")
            );
        }
    }

    private void handleConsoleDebug(@NotNull CommandContext<Sender> context) {
        Sender sender = context.sender();
        PlayerSelector targetName = context.getOrDefault("target", null);

        PolarisPlayer polarisacPlayer = parseTarget(sender, targetName.getSinglePlayer());
        if (polarisacPlayer == null) return;

        boolean isOutput = polarisacPlayer.checkManager.getDebugHandler().toggleConsoleOutput();
        String playerName = polarisacPlayer.user.getProfile().getName(); // Use user profile for name

        Component message = Component.text()
                .append(Component.text("Console output for ", NamedTextColor.GRAY))
                .append(Component.text(playerName, NamedTextColor.WHITE))
                .append(Component.text(" is now ", NamedTextColor.GRAY))
                .append(Component.text(isOutput ? "enabled" : "disabled", NamedTextColor.WHITE))
                .build();

        sender.sendMessage(message);
    }

    private @Nullable PolarisPlayer parseTarget(@NotNull Sender sender, @Nullable Sender t) {
        if (sender.isConsole() && t == null) {
            sender.sendMessage(MessageUtil.getParsedComponent(sender, "console-specify-target", "%prefix% &cYou must specify a target as the console!"));
            return null;
        }
        Sender target = t == null ? sender : t;

        PolarisPlayer polarisacPlayer = PolarisAPI.INSTANCE.getPlayerDataManager().getPlayer(target.getUniqueId());
        if (polarisacPlayer == null) {
            User user = PacketEvents.getAPI().getPlayerManager().getUser(sender.getPlatformPlayer().getNative());
            sender.sendMessage(MessageUtil.getParsedComponent(sender, "player-not-found", "%prefix% &cPlayer is exempt or offline!"));

            if (user == null) {
                sender.sendMessage(Component.text("Unknown PacketEvents user", NamedTextColor.RED));
            } else {
                boolean isExempt = PolarisAPI.INSTANCE.getPlayerDataManager().shouldCheck(user);
                if (!isExempt) {
                    sender.sendMessage(Component.text("User connection state: " + user.getConnectionState(), NamedTextColor.RED));
                }
            }
        }

        return polarisacPlayer;
    }
}
