// Emoton desktop shell. All logic lives in the library crate (src/lib.rs) so
// `cargo test` can reach it.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    emoton_lib::run();
}
