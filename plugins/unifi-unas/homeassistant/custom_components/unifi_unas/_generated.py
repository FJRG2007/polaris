# Auto-generated from polaris-unas-core. Do not edit by hand.
# Regenerate: cargo run -p polaris-unas-core --example gen_python
# Source of truth: plugins/unifi-unas/core (mqtt.rs, bays.rs).

DEVICE_MODELS = {
    "UNAS_PRO": "UNAS Pro (7-bay)",
    "UNAS_PRO_8": "UNAS Pro 8",
    "UNAS_PRO_4": "UNAS Pro 4",
    "UNAS_4": "UNAS 4",
    "UNAS_2": "UNAS 2",
    "UNVR": "UNVR",
    "UNVR_PRO": "UNVR Pro",
}

def get_mqtt_root(entry_id: str) -> str:
    return f"unas/{entry_id[:8]}"

def get_mqtt_topics(entry_id: str) -> dict:
    root = get_mqtt_root(entry_id)
    return {
        "root": root,
        "availability": f"{root}/availability",
        "control": f"{root}/control",
        "system": f"{root}/system",
        "hdd": f"{root}/hdd",
        "nvme": f"{root}/nvme",
        "pool": f"{root}/pool",
        "smb": f"{root}/smb",
        "nfs": f"{root}/nfs",
        "share": f"{root}/share",
    }
