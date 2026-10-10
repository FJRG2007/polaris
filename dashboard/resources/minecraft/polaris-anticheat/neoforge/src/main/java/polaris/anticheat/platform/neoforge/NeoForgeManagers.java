package polaris.anticheat.platform.neoforge;

import com.github.retrooper.packetevents.protocol.player.InteractionHand;
import net.minecraft.server.level.ServerPlayer;
import net.neoforged.fml.ModList;
import net.neoforged.neoforgespi.language.IModInfo;
import org.jetbrains.annotations.NotNull;
import org.jetbrains.annotations.Nullable;
import polaris.anticheat.platform.api.PlatformPlugin;
import polaris.anticheat.platform.api.manager.ItemResetHandler;
import polaris.anticheat.platform.api.manager.MessagePlaceHolderManager;
import polaris.anticheat.platform.api.manager.PermissionRegistrationManager;
import polaris.anticheat.platform.api.manager.PlatformPluginManager;
import polaris.anticheat.platform.api.permissions.PermissionDefaultValue;
import polaris.anticheat.platform.api.player.PlatformPlayer;
import polaris.anticheat.platform.neoforge.sender.NeoForgeSenderFactory;
import polaris.anticheat.platform.neoforge.utils.NeoForgeConversion;

import java.util.List;

/** The small platform services, as the upstream Fabric platform has them. */
final class NeoForgeManagers {

    private NeoForgeManagers() {
    }

    /** Mods stand in for plugins. */
    static final class Plugins implements PlatformPluginManager {
        @Override
        public PlatformPlugin[] getPlugins() {
            List<IModInfo> mods = ModList.get().getMods();
            return mods.stream().map(Plugins::of).toArray(PlatformPlugin[]::new);
        }

        @Override
        public PlatformPlugin getPlugin(String pluginName) {
            return ModList.get().getModContainerById(pluginName.toLowerCase(java.util.Locale.ROOT))
                    .map(container -> of(container.getModInfo()))
                    .orElse(null);
        }

        private static PlatformPlugin of(IModInfo info) {
            return new PlatformPlugin() {
                @Override
                public boolean isEnabled() {
                    return true;
                }

                @Override
                public String getName() {
                    return info.getModId();
                }

                @Override
                public String getVersion() {
                    return info.getVersion().toString();
                }
            };
        }
    }

    /** No placeholder mod is looked for. */
    static final class Placeholders implements MessagePlaceHolderManager {
        @Override
        public @NotNull String replacePlaceholders(@Nullable PlatformPlayer player, @NotNull String string) {
            return string;
        }
    }

    static final class Permissions implements PermissionRegistrationManager {
        private final NeoForgeSenderFactory senders;

        Permissions(NeoForgeSenderFactory senders) {
            this.senders = senders;
            for (String node : new String[] {
                    "polarisac.exempt", "polarisac.nosetback", "polarisac.nomodifypacket", "polarisac.disabled",
                    "polarisac.alerts.enable-on-join", "polarisac.verbose.enable-on-join",
                    "polarisac.brand.enable-on-join", "polarisac.alerts.enable-on-join.silent",
                    "polarisac.verbose.enable-on-join.silent", "polarisac.brand.enable-on-join.silent"}) {
                registerPermission(node, PermissionDefaultValue.FALSE);
            }
        }

        @Override
        public void registerPermission(String name, PermissionDefaultValue defaultValue) {
            senders.registerPermissionDefault(name, defaultValue);
        }
    }

    static final class ItemReset implements ItemResetHandler {
        @Override
        public void resetItemUsage(@Nullable PlatformPlayer player) {
            if (player != null && player.getNative() instanceof ServerPlayer serverPlayer) {
                serverPlayer.stopUsingItem();
            }
        }

        @Override
        public @Nullable InteractionHand getItemUsageHand(@Nullable PlatformPlayer player) {
            if (player == null || !(player.getNative() instanceof ServerPlayer serverPlayer)) return null;
            return serverPlayer.isUsingItem() ? NeoForgeConversion.fromNativeHand(serverPlayer.getUsedItemHand()) : null;
        }

        @Override
        public boolean isUsingItem(@Nullable PlatformPlayer player) {
            return player != null && player.getNative() instanceof ServerPlayer serverPlayer && serverPlayer.isUsingItem();
        }
    }
}
