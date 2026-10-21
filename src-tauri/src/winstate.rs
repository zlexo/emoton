//! Window size and position between launches, in LOGICAL units.
//!
//! Why not tauri-plugin-window-state: it stores physical pixels, and on this
//! Mac (built-in 2x Retina plus an external 1x display) the saved window
//! came back HALF the size on every launch (measured: 1100x720 → 550x360 →
//! 275x180). macOS itself positions windows in points, so logical units
//! round-trip exactly whatever screen the window lands on.

use serde::{Deserialize, Serialize};
use std::path::Path;

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Geometry {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    #[serde(default)]
    pub maximized: bool,
}

/// A monitor's work area (without menu bar and Dock) in logical units.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// Mirrors minWidth/minHeight in tauri.conf.json. macOS only enforces the
/// minimum for user resizing, so a restore has to clamp itself.
pub const MIN_SIZE: (f64, f64) = (1000.0, 680.0);

/// What to apply for a saved geometry, given the monitors now attached.
/// None: the saved spot is on no monitor any more (unplugged display), so
/// the caller centers the window instead. An empty monitor list means "not
/// known" (seen in scripted launches on this Mac while NSScreen still listed
/// two screens; probably the displays were asleep): the saved
/// geometry is kept, with only the minimum size enforced.
pub fn fit(saved: Geometry, monitors: &[Rect]) -> Option<Geometry> {
    if !(saved.x.is_finite() && saved.y.is_finite() && saved.width.is_finite() && saved.height.is_finite()) {
        return None;
    }
    if monitors.is_empty() {
        return Some(Geometry { width: saved.width.max(MIN_SIZE.0), height: saved.height.max(MIN_SIZE.1), ..saved });
    }
    // The title bar must be reachable: a 100x30 patch at the window's top
    // left has to overlap a monitor, or the user cannot drag it back.
    let grab = Rect { x: saved.x, y: saved.y, width: 100.0, height: 30.0 };
    let m = monitors.iter().find(|m| overlaps(&grab, m))?;
    let width = saved.width.max(MIN_SIZE.0).min(m.width.max(MIN_SIZE.0));
    let height = saved.height.max(MIN_SIZE.1).min(m.height.max(MIN_SIZE.1));
    // Inside the work area (not under the menu bar or the Dock) when it fits.
    let x = saved.x.min(m.x + m.width - width).max(m.x);
    let y = saved.y.min(m.y + m.height - height).max(m.y);
    Some(Geometry { x, y, width, height, ..saved })
}

fn overlaps(a: &Rect, b: &Rect) -> bool {
    a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height
}

pub fn load(path: &Path) -> Option<Geometry> {
    serde_json::from_str(&std::fs::read_to_string(path).ok()?).ok()
}

/// Write to a temp file, then rename: a crash mid-write leaves the old file.
pub fn save(path: &Path, g: &Geometry) -> std::io::Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_string_pretty(g).unwrap_or_default())?;
    std::fs::rename(&tmp, path)
}

#[cfg(test)]
mod tests {
    use super::*;

    const WIDE: Rect = Rect { x: 0.0, y: 0.0, width: 1920.0, height: 1080.0 };
    const RETINA_LEFT: Rect = Rect { x: -1470.0, y: 200.0, width: 1470.0, height: 956.0 };

    fn g(x: f64, y: f64, w: f64, h: f64) -> Geometry {
        Geometry { x, y, width: w, height: h, maximized: false }
    }

    #[test]
    fn keeps_a_valid_geometry_exactly() {
        let s = g(60.0, 80.0, 1100.0, 720.0);
        assert_eq!(fit(s, &[WIDE]), Some(s));
        let left = g(-1400.0, 260.0, 1200.0, 800.0);
        assert_eq!(fit(left, &[WIDE, RETINA_LEFT]), Some(left));
    }

    #[test]
    fn off_screen_means_center_instead() {
        assert_eq!(fit(g(-1400.0, 260.0, 1200.0, 800.0), &[WIDE]), None, "the left display was unplugged");
        assert_eq!(fit(g(5000.0, 80.0, 1200.0, 800.0), &[WIDE]), None);
        assert_eq!(fit(g(f64::NAN, 80.0, 1200.0, 800.0), &[WIDE]), None);
        assert_eq!(fit(g(60.0, 80.0, 1200.0, 800.0), &[]), Some(g(60.0, 80.0, 1200.0, 800.0)), "no monitors known yet");
        assert_eq!(fit(g(60.0, 80.0, 500.0, 300.0), &[]), Some(g(60.0, 80.0, 1000.0, 680.0)));
    }

    #[test]
    fn clamps_below_the_minimum_and_above_the_monitor() {
        // What the old plugin saved after two launches on the mixed-DPI setup.
        assert_eq!(fit(g(15.0, 30.0, 275.0, 180.0), &[WIDE]), Some(g(15.0, 30.0, 1000.0, 680.0)));
        assert_eq!(fit(g(0.0, 0.0, 4000.0, 3000.0), &[WIDE]), Some(g(0.0, 0.0, 1920.0, 1080.0)));
    }

    #[test]
    fn moves_into_the_work_area() {
        // Work area below a 25 pt menu bar and above a 70 pt Dock.
        let wa = Rect { x: 0.0, y: 25.0, width: 1920.0, height: 985.0 };
        // Partly under the menu bar, and hanging off the right and bottom.
        assert_eq!(fit(g(1500.0, 10.0, 1200.0, 800.0), &[wa]), Some(g(720.0, 25.0, 1200.0, 800.0)));
        assert_eq!(fit(g(900.0, 400.0, 1200.0, 800.0), &[wa]), Some(g(720.0, 210.0, 1200.0, 800.0)));
    }

    #[test]
    fn round_trips_through_the_file() {
        let dir = std::env::temp_dir().join(format!("emoton-winstate-{}", std::process::id()));
        let p = dir.join("window.json");
        let s = Geometry { maximized: true, ..g(12.5, 40.0, 1300.0, 850.0) };
        save(&p, &s).unwrap();
        assert_eq!(load(&p), Some(s));
        assert!(!p.with_extension("json.tmp").exists());
        std::fs::write(&p, "garbage").unwrap();
        assert_eq!(load(&p), None);
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
