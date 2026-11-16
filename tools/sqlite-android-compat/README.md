# sqlite-android-compat

Applies every migration with SQLite 3.39 — what Android 14 (the app's minimum)
ships, and so what the Android check-in worker opens the database with — then
makes the writes that worker makes and checks the sync triggers recorded them.

    cargo run --manifest-path tools/sqlite-android-compat/Cargo.toml -- .

Runs in the Android CI workflow. Kept out of `src-tauri`'s build because it
links a second, older SQLite.
