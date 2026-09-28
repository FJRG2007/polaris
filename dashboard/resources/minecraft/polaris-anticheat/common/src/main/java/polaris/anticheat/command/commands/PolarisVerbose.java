package polaris.anticheat.command.commands;

import polaris.anticheat.PolarisAPI;
import polaris.anticheat.command.BuildableCommand;
import polaris.anticheat.manager.AlertManagerImpl;
import polaris.anticheat.manager.datastore.PlayerToggleStore;
import polaris.anticheat.platform.api.manager.cloud.CloudPlatformCommandArguments;
import polaris.anticheat.platform.api.player.PlatformPlayer;
import polaris.anticheat.platform.api.sender.Sender;
import org.incendo.cloud.CommandManager;
import org.incendo.cloud.context.CommandContext;
import org.jetbrains.annotations.NotNull;

import java.util.Objects;

public class PolarisVerbose implements BuildableCommand {
    @Override
    public void register(CommandManager<Sender> commandManager, CloudPlatformCommandArguments arguments) {
        commandManager.command(
                commandManager.commandBuilder("polarisac", "polarisac")
                        .literal("verbose")
                        .permission("polarisac.verbose")
                        .handler(this::handleVerbose)
        );
    }

    private void handleVerbose(@NotNull CommandContext<Sender> context) {
        Sender sender = context.sender();
        if (sender.isPlayer()) {
            PlatformPlayer player = Objects.requireNonNull(context.sender().getPlatformPlayer(), "player");
            AlertManagerImpl am = PolarisAPI.INSTANCE.getAlertManager();
            boolean newState = !am.hasVerboseEnabled(player);
            am.setVerboseEnabled(player, newState, false);
            PlayerToggleStore toggles = PolarisAPI.INSTANCE.getDataStoreLifecycle().playerToggleStore();
            toggles.applyUserToggle(player.getUniqueId(), PlayerToggleStore.KEY_VERBOSE, newState);
            // setVerboseEnabled(true) cascades to setAlertsEnabled(true) in AlertManager
            // — mirror that into the toggle store so the persisted alerts row tracks the
            // implied state, otherwise a verbose-on staff member would re-toggle alerts
            // off on next reconnect when persisted alerts is still false.
            if (newState) toggles.applyUserToggle(player.getUniqueId(), PlayerToggleStore.KEY_ALERTS, true);
        } else if (sender.isConsole()) {
            PolarisAPI.INSTANCE.getAlertManager().toggleConsoleVerbose();
        }
    }
}
