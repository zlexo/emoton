fn main() {
    // The app's own command (the splash's "Try again") must be declared to
    // the ACL; this generates the allow-retry permission that
    // capabilities/splash.json grants. The server's origin never gets it.
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(tauri_build::AppManifest::new().commands(&["retry"])))
        .expect("failed to run tauri-build");
}
