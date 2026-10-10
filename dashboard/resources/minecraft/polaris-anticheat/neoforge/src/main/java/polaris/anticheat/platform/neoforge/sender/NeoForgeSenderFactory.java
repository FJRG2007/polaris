package polaris.anticheat.platform.neoforge.sender;

import net.kyori.adventure.text.Component;
import net.minecraft.commands.CommandSource;
import net.minecraft.commands.CommandSourceStack;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.server.rcon.RconConsoleSource;
import org.jetbrains.annotations.Nullable;
import polaris.anticheat.platform.api.permissions.PermissionDefaultValue;
import polaris.anticheat.platform.api.sender.Sender;
import polaris.anticheat.platform.api.sender.SenderFactory;
import polaris.anticheat.platform.neoforge.NeoForgeServer;
import polaris.anticheat.platform.neoforge.utils.NeoForgeConversion;

import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Command sources as the engine's senders. Permissions are the registered defaults
 * resolved against the operator level, as on Fabric without a permissions mod.
 */
public final class NeoForgeSenderFactory extends SenderFactory<CommandSourceStack> {

    private final Map<String, PermissionDefaultValue> permissionDefaults = new ConcurrentHashMap<>();

    public void registerPermissionDefault(String permission, PermissionDefaultValue defaultValue) {
        permissionDefaults.put(permission, defaultValue);
    }

    @Override
    protected UUID getUniqueId(CommandSourceStack sender) {
        return sender.getEntity() != null ? sender.getEntity().getUUID() : Sender.CONSOLE_UUID;
    }

    @Override
    protected String getName(CommandSourceStack sender) {
        String name = sender.getTextName();
        return sender.getEntity() == null && name.equals("Server") ? Sender.CONSOLE_NAME : name;
    }

    @Override
    protected void sendMessage(CommandSourceStack sender, String message) {
        sender.sendSystemMessage(net.minecraft.network.chat.Component.literal(message));
    }

    @Override
    protected void sendMessage(CommandSourceStack sender, Component message) {
        sender.sendSystemMessage(NeoForgeConversion.toNativeText(message));
    }

    @Override
    protected boolean hasPermission(CommandSourceStack sender, String node) {
        PermissionDefaultValue value = permissionDefaults.get(node);
        return value == null ? isOperator(sender) : resolve(value, sender);
    }

    @Override
    protected boolean hasPermission(CommandSourceStack sender, String node, boolean defaultIfUnset) {
        PermissionDefaultValue value = permissionDefaults.get(node);
        return value == null ? defaultIfUnset : resolve(value, sender);
    }

    private boolean resolve(PermissionDefaultValue value, CommandSourceStack sender) {
        return switch (value) {
            case TRUE -> true;
            case FALSE -> false;
            case OP -> isOperator(sender);
            case NOT_OP -> !isOperator(sender);
        };
    }

    private boolean isOperator(CommandSourceStack sender) {
        MinecraftServer server = sender.getServer();
        return sender.hasPermission(server.getOperatorUserPermissionLevel());
    }

    @Override
    protected void performCommand(CommandSourceStack sender, String command) {
        MinecraftServer server = NeoForgeServer.get();
        if (server != null) server.getCommands().performPrefixedCommand(sender, command);
    }

    @Override
    protected boolean isConsole(CommandSourceStack sender) {
        CommandSource source = sender.source;
        return source == sender.getServer()
                || source.getClass() == RconConsoleSource.class
                || (source == CommandSource.NULL && sender.getTextName().isEmpty());
    }

    @Override
    protected boolean isPlayer(CommandSourceStack sender) {
        return sender.getEntity() instanceof ServerPlayer;
    }

    public @Nullable Sender console() {
        MinecraftServer server = NeoForgeServer.get();
        return server == null ? null : wrap(server.createCommandSourceStack());
    }
}
