//! System sensors (macOS): CPU %, memory %, battery (level/charging), clock.
use crate::rules::SystemState;
use chrono::{Local, Timelike};
use std::process::Command;
use sysinfo::System;

pub struct Sensors {
    sys: System,
}

impl Sensors {
    pub fn new() -> Self {
        let mut sys = System::new();
        sys.refresh_cpu_usage();
        sys.refresh_memory();
        Self { sys }
    }

    pub fn sample(&mut self) -> SystemState {
        self.sys.refresh_cpu_usage();
        self.sys.refresh_memory();
        let cpu = self.sys.global_cpu_usage();
        let total = self.sys.total_memory();
        let mem = if total > 0 {
            self.sys.used_memory() as f32 / total as f32 * 100.0
        } else {
            0.0
        };
        let (battery, charging) = battery_mac();
        let now = Local::now();
        SystemState {
            cpu,
            mem,
            battery,
            charging,
            hour: now.hour() as u8,
            minute: now.minute() as u8,
        }
    }
}

/// Read battery via `pmset -g batt` (macOS). Returns (percent, charging).
fn battery_mac() -> (Option<f32>, bool) {
    let out = match Command::new("pmset").args(["-g", "batt"]).output() {
        Ok(o) => o,
        Err(_) => return (None, false),
    };
    let s = String::from_utf8_lossy(&out.stdout);
    let pct = s.find('%').and_then(|i| {
        let pre = &s[..i];
        let digits: String = pre.chars().rev().take_while(|c| c.is_ascii_digit()).collect();
        let digits: String = digits.chars().rev().collect();
        digits.parse::<f32>().ok()
    });
    // "discharging" contains "charging", so check it first.
    let discharging = s.contains("discharging");
    let charging =
        !discharging && (s.contains("AC Power") || s.contains("charging") || s.contains("charged"));
    (pct, charging)
}
