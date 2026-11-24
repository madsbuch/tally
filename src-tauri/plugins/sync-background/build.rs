const COMMANDS: &[&str] = &["schedule", "cancel", "hold_multicast_lock"];

fn main() {
    tauri_plugin::Builder::new(COMMANDS)
        .android_path("android")
        .build();
}
