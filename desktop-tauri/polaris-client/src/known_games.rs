//! Games this app recognizes by the program that runs them. Mirrors
//! `desktop/src/main/known-games.ts`, which stays the one place the list is
//! edited: a test reads that file and fails when this table says anything else.
//!
//! Matched against the bare name of each running program, lowercased, the way
//! the dashboard keys a game (`gameKeyOf`). Deliberately short and exact: a name
//! many programs share (`java`, `javaw.exe`, `python`) is never on it. A game
//! running through a compatibility layer on Linux keeps its Windows program name,
//! which is why most entries have only the `.exe` form and still match there.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct KnownGame {
    /// What the card says: "Playing <name>".
    pub name: &'static str,
    /// The programs that mean it is running, lowercased, without a folder.
    pub programs: &'static [&'static str],
}

const fn game(name: &'static str, programs: &'static [&'static str]) -> KnownGame {
    KnownGame { name, programs }
}

pub const KNOWN_GAMES: &[KnownGame] = &[
    game("Among Us", &["among us.exe"]),
    game("Apex Legends", &["r5apex.exe"]),
    game("ARK: Survival Evolved", &["shootergame.exe"]),
    game("Baldur's Gate 3", &["bg3.exe", "bg3_dx11.exe"]),
    game("Celeste", &["celeste.exe"]),
    game("Counter-Strike 2", &["cs2.exe", "cs2"]),
    game("Cyberpunk 2077", &["cyberpunk2077.exe"]),
    game("Dead by Daylight", &["deadbydaylight-win64-shipping.exe"]),
    game("Dota 2", &["dota2.exe", "dota2"]),
    game("Elden Ring", &["eldenring.exe"]),
    game("Factorio", &["factorio.exe", "factorio"]),
    game("FiveM", &["fivem.exe"]),
    game("Fortnite", &["fortniteclient-win64-shipping.exe"]),
    game("Genshin Impact", &["genshinimpact.exe"]),
    game("Grand Theft Auto V", &["gta5.exe"]),
    game("Helldivers 2", &["helldivers2.exe"]),
    game("Hollow Knight", &["hollow_knight.exe"]),
    game("Lethal Company", &["lethal company.exe"]),
    game("League of Legends", &["league of legends.exe"]),
    game("Minecraft", &["minecraft.windows.exe"]),
    game("osu!", &["osu!.exe"]),
    game("Overwatch 2", &["overwatch.exe"]),
    game("Palworld", &["palworld-win64-shipping.exe"]),
    game("PUBG: Battlegrounds", &["tslgame.exe"]),
    game("Rainbow Six Siege", &["rainbowsix.exe"]),
    game("Roblox", &["robloxplayerbeta.exe"]),
    game("Rocket League", &["rocketleague.exe"]),
    game("Rust", &["rustclient.exe"]),
    game("Sea of Thieves", &["sotgame.exe"]),
    game("Terraria", &["terraria.exe"]),
    game("The Sims 4", &["ts4_x64.exe"]),
    game("Valheim", &["valheim.exe"]),
    game("VALORANT", &["valorant-win64-shipping.exe"]),
    game("World of Warcraft", &["wow.exe"]),
];
