package polaris.minecraft;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import java.util.Arrays;
import org.bukkit.command.CommandExecutor;
import org.bukkit.command.PluginCommand;
import org.bukkit.entity.Player;
import org.bukkit.plugin.java.JavaPlugin;

/**
 * Polaris on a Paper, Purpur or Spigot server.
 *
 * Everything it does happens on the server, and a player joins with an unmodified
 * client. Each part stays idle unless the server's environment switches it on,
 * which is what makes a jar left in the plugins folder after the switch was
 * turned off harmless: the login with {@code POLARIS_LOGIN=on}, and the server's
 * own sounds ({@link SoundPack}) wherever Polaris wrote its address, id and token
 * (unless {@code POLARIS_SOUNDS=off}). Where an event's players respawn
 * ({@link EventRespawn}), the guard on an event's space ({@link EventGuard})
 * and the seasonal decorations ({@link SeasonalDecor})
 * are idle until the dashboard runs one of their commands.
 */
public final class PolarisPlugin extends JavaPlugin {
    private LoginGate gate;
    private SoundPack sounds;
    private SeasonalDecor seasonal;
    private SeasonalHalloween halloween;
    private SeasonalWinter winter;

    @Override
    public void onEnable() {
        String version = getDescription().getVersion();
        sounds = SoundPack.start(this, version);
        EventRespawn respawns = new EventRespawn();
        getServer().getPluginManager().registerEvents(respawns, this);
        // An impostor game's dead talk only to each other; idle outside one.
        getServer().getPluginManager().registerEvents(new EventGhosts(), this);
        // Nobody outside an event changes its space; idle until one is guarded.
        EventGuard guard = new EventGuard(this);
        getServer().getPluginManager().registerEvents(guard, this);
        // The season Polaris says it is, on players' screens only; idle until told.
        seasonal = new SeasonalDecor(this);
        getServer().getPluginManager().registerEvents(seasonal, this);
        seasonal.listenForPicks();
        getServer().getPluginManager().registerEvents(seasonal.mobs(), this);
        // Christmas and New Year's Eve on top of the winter; idle until told.
        winter = new SeasonalWinter(this, seasonal);
        getServer().getPluginManager().registerEvents(winter, this);
        getServer().getPluginManager().registerEvents(winter.gifts(), this);
        winter.start();
        SeasonalWinter christmas = winter;
        SeasonalDecor season = seasonal;
        halloween = new SeasonalHalloween(this, seasonal);
        getServer().getPluginManager().registerEvents(halloween, this);
        halloween.start();
        SeasonalHalloween extras = halloween;
        PluginCommand polaris = getCommand("polaris");
        if (polaris != null) {
            CommandExecutor soundsCommand = sounds != null
                    ? sounds
                    : (sender, command, label, args) -> {
                        sender.sendMessage(SoundPack.refused("off").toString());
                        return true;
                    };
            polaris.setExecutor((sender, command, label, args) -> {
                if (args.length == 0 || args[0].equalsIgnoreCase("sounds"))
                    return soundsCommand.onCommand(sender, command, label, args);
                JsonObject reply;
                if (sender instanceof Player) reply = SoundPack.refused("console");
                else if (args[0].equalsIgnoreCase("caps") || args[0].equalsIgnoreCase("capabilities"))
                    reply = caps(version);
                else if (args[0].equalsIgnoreCase("respawn"))
                    reply = respawns.answer(Arrays.copyOfRange(args, 1, args.length));
                else if (args[0].equalsIgnoreCase("guard"))
                    reply = guard.answer(Arrays.copyOfRange(args, 1, args.length));
                else if (args[0].equalsIgnoreCase("season") && args.length > 1 && args[1].equalsIgnoreCase("halloween"))
                    reply = extras.configure(Arrays.copyOfRange(args, 2, args.length));
                else if (args[0].equalsIgnoreCase("season") && args.length > 1 && args[1].equalsIgnoreCase("winter"))
                    reply = christmas.answer(Arrays.copyOfRange(args, 2, args.length));
                else if (args[0].equalsIgnoreCase("season"))
                    reply = season.answer(Arrays.copyOfRange(args, 1, args.length));
                else reply = SoundPack.refused("usage");
                sender.sendMessage(reply.toString());
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

    /** `polaris caps`: what the dashboard may ask of this plugin, as the NeoForge
     *  mod answers it. Only `respawn`, `guard`, `season`, `season-mobs`, `season-halloween` and `season-winter` here: the rest are the mod's alone. */
    private static JsonObject caps(String version) {
        JsonObject reply = new JsonObject();
        reply.addProperty("ok", true);
        reply.addProperty("polaris", version);
        JsonArray caps = new JsonArray();
        caps.add("respawn");
        caps.add("guard");
        caps.add("season");
        caps.add("season-mobs");
        caps.add("season-halloween");
        caps.add("season-winter");
        reply.add("caps", caps);
        return reply;
    }

    @Override
    public void onDisable() {
        if (gate != null) gate.stop();
        gate = null;
        if (sounds != null) sounds.stop();
        sounds = null;
        if (halloween != null) halloween.stop();
        halloween = null;
        if (winter != null) winter.stop();
        winter = null;
        if (seasonal != null) seasonal.stop();
        seasonal = null;
        CommandLogFilter.uninstall();
    }
}
