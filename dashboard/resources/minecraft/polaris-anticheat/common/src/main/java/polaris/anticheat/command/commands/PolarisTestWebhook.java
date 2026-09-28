package polaris.anticheat.command.commands;

import polaris.anticheat.PolarisAPI;
import polaris.anticheat.command.BuildableCommand;
import polaris.anticheat.platform.api.manager.cloud.CloudPlatformCommandArguments;
import polaris.anticheat.platform.api.sender.Sender;
import polaris.anticheat.utils.anticheat.LogUtil;
import polaris.anticheat.utils.anticheat.MessageUtil;
import polaris.anticheat.utils.data.webhook.discord.WebhookMessage;
import org.incendo.cloud.CommandManager;
import org.incendo.cloud.context.CommandContext;
import org.jetbrains.annotations.NotNull;

public class PolarisTestWebhook implements BuildableCommand {
    @Override
    public void register(CommandManager<Sender> commandManager, CloudPlatformCommandArguments arguments) {
        commandManager.command(
                commandManager.commandBuilder("polarisac", "polarisac")
                        .literal("testwebhook")
                        .permission("polarisac.testwebhook")
                        .handler(this::handleTestWebhook)
        );
    }

    private void handleTestWebhook(@NotNull CommandContext<Sender> context) {
        if (PolarisAPI.INSTANCE.getDiscordManager().isDisabled()) {
            context.sender().sendMessage(MessageUtil.miniMessage(PolarisAPI.INSTANCE.getConfigManager().getWebhookNotEnabled()));
            return;
        }

        WebhookMessage webhookMessage = new WebhookMessage().content(PolarisAPI.INSTANCE.getConfigManager().getWebhookTestMessage());
        PolarisAPI.INSTANCE.getDiscordManager().sendWebhookMessage(webhookMessage).whenCompleteAsync(((successful, throwable) -> {
            if (successful == true) {
                context.sender().sendMessage(MessageUtil.miniMessage(PolarisAPI.INSTANCE.getConfigManager().getWebhookTestSucceeded()));
                return;
            }

            context.sender().sendMessage(MessageUtil.miniMessage(PolarisAPI.INSTANCE.getConfigManager().getWebhookTestFailed()));

            if (throwable != null) {
                LogUtil.error("Exception caught while sending a Discord webhook test alert", throwable);
            }
        }));
    }
}
