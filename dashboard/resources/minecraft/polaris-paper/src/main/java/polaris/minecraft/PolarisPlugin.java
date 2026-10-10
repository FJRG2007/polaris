package polaris.minecraft;

import org.bukkit.command.PluginCommand;
import org.bukkit.plugin.java.JavaPlugin;

/**
 * Polaris on a Paper, Purpur or Spigot server.
 *
 * Everything it does happens on the server, and a player joins with an unmodified
 * client. Each part stays idle unless the server's environment switches it on,
 * which is what makes a jar left in the plugins folder after the switch was
 * turned off harmless: the login with {@code POLARIS_LOGIN=on}, and the server's
 * own sounds ({@link SoundPack}) wherever Polaris wrote its address, id and token
 * (unless {@code POLARIS_SOUNDS=off}).
 */
public final class PolarisPlugin extends JavaPlugin {
    private LoginGate gate;
    private SoundPack sounds;

    @Override
    public void onEnable() {
        String version = getDescription().getVersion();
        sounds = SoundPack.start(this, version);
        PluginCommand polaris = getCommand("polaris");
        if (polaris != null) {
            polaris.setExecutor(sounds != null
                    ? sounds
                    : (sender, command, label, args) -> {
                        sender.sendMessage(SoundPack.refused("off").toString());
                        return true;
                    });
        }
        PolarisConfig config = PolarisConfig.fromEnvironment(System.getenv());
        switch (config.state()) {
            case OFF -> {
                getLogger().info("Polaris login is installed but switched off for this server.");
                return;
            }
            case BROKEN -> getLogger().severe("Polaris login is switched on but cannot run: " + config.problem()
                    + ". Every player will be refused until this is fixed.");
            case ON -> getLogger().info("Polaris login is on. Players are checked against " + config.baseUrl() + ".");
        }
        CommandLogFilter.install();
        gate = new LoginGate(this, config, new PolarisClient(config, version), version);
        gate.start();
    }

    @Override
    public void onDisable() {
        if (gate != null) gate.stop();
        gate = null;
        if (sounds != null) sounds.stop();
        sounds = null;
        CommandLogFilter.uninstall();
    }
}
