package polaris.anticheat.command.commands;

import polaris.anticheat.PolarisAPI;
import polaris.anticheat.command.BuildableCommand;
import polaris.anticheat.manager.init.start.SuperDebug;
import polaris.anticheat.platform.api.manager.cloud.CloudPlatformCommandArguments;
import polaris.anticheat.platform.api.sender.Sender;
import polaris.anticheat.utils.anticheat.LogUtil;
import polaris.anticheat.utils.anticheat.MessageUtil;
import org.incendo.cloud.Command;
import org.incendo.cloud.CommandManager;
import org.incendo.cloud.context.CommandContext;
import org.incendo.cloud.parser.standard.IntegerParser;
import org.jetbrains.annotations.NotNull;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.LocalDateTime;
import java.time.format.DateTimeFormatter;
import java.util.function.Consumer;

public class PolarisLog implements BuildableCommand {
    public static void sendLogAsync(Sender sender, String log, Consumer<String> consumer, String type) {
        String success = PolarisAPI.INSTANCE.getConfigManager().getConfig().getStringElse("upload-log", "%prefix% &fSaved to: %url%");
        String failure = PolarisAPI.INSTANCE.getConfigManager().getConfig().getStringElse("upload-log-upload-failure", "%prefix% &cSomething went wrong while saving this log, see console for more information.");
        PolarisAPI.INSTANCE.getScheduler().getAsyncScheduler().runNow(PolarisAPI.INSTANCE.getPolarisPlugin(), () -> {
            try {
                String saved = saveLog(log, type);
                String message = success.replace("%url%", saved);
                consumer.accept(message);
                sender.sendMessage(MessageUtil.miniMessage(MessageUtil.replacePlaceholders(sender, message)));
            } catch (Exception e) {
                sender.sendMessage(MessageUtil.miniMessage(MessageUtil.replacePlaceholders(sender, failure)));
                LogUtil.error("Failed to save log", e);
            }
        });
    }

    /**
     * Keep a log on the server, in the plugin's folder, and answer where. It used
     * to be uploaded to a paste service run by somebody else; nothing leaves the
     * server now, and the path is what whoever runs it can open.
     */
    private static String saveLog(String log, String type) throws IOException {
        Path folder = PolarisAPI.INSTANCE.getPolarisPlugin().getDataFolder().toPath().resolve("logs");
        Files.createDirectories(folder);
        String extension = type.contains("yaml") ? ".yml" : ".txt";
        String name = "log-" + DateTimeFormatter.ofPattern("yyyyMMdd-HHmmss-SSS").format(LocalDateTime.now()) + extension;
        Files.writeString(folder.resolve(name), log, StandardCharsets.UTF_8);
        return "plugins/" + PolarisAPI.INSTANCE.getPolarisPlugin().getDataFolder().getName() + "/logs/" + name;
    }

    @Override
    public void register(CommandManager<Sender> commandManager, CloudPlatformCommandArguments arguments) {
        Command<Sender> command = commandManager.commandBuilder("polarisac", "polarisac")
                .literal("log", "logs")
                .permission("polarisac.log")
                .required("flagId", IntegerParser.integerParser())
                .handler(this::handleLog)
                .manager(commandManager)
                .build();
        commandManager
                .command(command)
                .command(commandManager.commandBuilder("gl").proxies(command));
    }

    private void handleLog(@NotNull CommandContext<Sender> context) {
        Sender sender = context.sender();
        int flagId = context.get("flagId");

        StringBuilder builder = SuperDebug.getFlag(flagId);
        if (builder == null) {
            sender.sendMessage(MessageUtil.getParsedComponent(sender, "upload-log-not-found", "%prefix% &cUnable to find that log"));
            return;
        }
        sendLogAsync(sender, builder.toString(), string -> {}, "text/yaml");
    }
}
