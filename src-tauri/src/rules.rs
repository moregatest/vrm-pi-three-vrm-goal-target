//! Pure, deterministic rules engine: system state -> VRM actions.
//! No I/O here, so it is fully unit-testable (see `mod tests`).
use serde::Serialize;

#[derive(Debug, Clone, Copy)]
pub struct SystemState {
    pub cpu: f32,             // 0..100 (%)
    pub mem: f32,             // 0..100 (%)
    pub battery: Option<f32>, // 0..100 (%), None if no battery
    pub charging: bool,
    pub hour: u8,             // 0..23 (local)
    pub minute: u8,           // 0..59
}

/// An action pushed to the browser runtime. Serializes to the same shape the
/// SSE bridge uses, e.g. {"type":"expression","emotion":"happy"}.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum VrmAction {
    Expression { emotion: String },
    Motion { motion: String },
    Say { text: String },
}

#[derive(Default)]
pub struct RuleMemory {
    pub last_charging: Option<bool>,
    pub last_hour_announced: Option<u8>,
    pub last_emotion: Option<String>,
    pub tick: u64,
    pub last_nod_tick: u64,
}

fn low_batt(s: &SystemState) -> bool {
    matches!(s.battery, Some(b) if b < 20.0) && !s.charging
}

/// Priority-ordered emotion from current load/battery.
fn pick_emotion(s: &SystemState) -> &'static str {
    if low_batt(s) { return "sad"; }
    if s.cpu > 85.0 { return "angry"; }
    if s.cpu > 70.0 { return "surprised"; }
    if s.mem > 85.0 { return "sad"; }
    if s.cpu < 25.0 { return "relaxed"; }
    "neutral"
}

fn to12(h: u8) -> u8 {
    let h = h % 12;
    if h == 0 { 12 } else { h }
}

/// Decide actions for this tick. Emits only on change / rising edge so the
/// avatar never spams. `m` carries hysteresis state across ticks.
pub fn decide(s: SystemState, m: &mut RuleMemory) -> Vec<VrmAction> {
    m.tick += 1;
    let mut out = Vec::new();

    // battery: rising edge into charging
    if m.last_charging == Some(false) && s.charging {
        out.push(VrmAction::Expression { emotion: "happy".into() });
        out.push(VrmAction::Motion { motion: "wave".into() });
        out.push(VrmAction::Say { text: "Ah, power! Thank you!".into() });
    }
    m.last_charging = Some(s.charging);

    // top of the hour: announce once per hour
    if s.minute == 0 && m.last_hour_announced != Some(s.hour) {
        out.push(VrmAction::Motion { motion: "wave".into() });
        out.push(VrmAction::Say { text: format!("It's {} o'clock!", to12(s.hour)) });
        m.last_hour_announced = Some(s.hour);
    }

    // emotion: only when it changes
    let emotion = pick_emotion(&s);
    if m.last_emotion.as_deref() != Some(emotion) {
        out.push(VrmAction::Expression { emotion: emotion.into() });
        if emotion == "sad" && low_batt(&s) {
            out.push(VrmAction::Say { text: "My battery's getting low…".into() });
        } else if emotion == "angry" {
            out.push(VrmAction::Say { text: "Phew, I'm flat out here!".into() });
        }
        m.last_emotion = Some(emotion.into());
    }

    // idle liveliness: an occasional nod while relaxed
    if emotion == "relaxed" && m.tick.saturating_sub(m.last_nod_tick) >= 20 {
        out.push(VrmAction::Motion { motion: "nod".into() });
        m.last_nod_tick = m.tick;
    }

    out
}

#[cfg(test)]
mod tests {
    use super::*;
    fn base() -> SystemState {
        SystemState { cpu: 10.0, mem: 30.0, battery: Some(80.0), charging: false, hour: 10, minute: 30 }
    }
    fn has_expr(a: &[VrmAction], e: &str) -> bool {
        a.iter().any(|x| matches!(x, VrmAction::Expression { emotion } if emotion == e))
    }
    fn has_motion(a: &[VrmAction], mo: &str) -> bool {
        a.iter().any(|x| matches!(x, VrmAction::Motion { motion } if motion == mo))
    }
    fn has_say(a: &[VrmAction], sub: &str) -> bool {
        a.iter().any(|x| matches!(x, VrmAction::Say { text } if text.contains(sub)))
    }

    #[test]
    fn high_cpu_is_angry_but_debounced() {
        let mut m = RuleMemory::default();
        let s = SystemState { cpu: 95.0, ..base() };
        let a = decide(s, &mut m);
        assert!(has_expr(&a, "angry"));
        assert!(has_say(&a, "flat out"));
        let a2 = decide(s, &mut m); // same state again
        assert!(!a2.iter().any(|x| matches!(x, VrmAction::Expression { .. })));
    }

    #[test]
    fn charging_rising_edge_waves_happy() {
        let mut m = RuleMemory::default();
        decide(SystemState { charging: false, ..base() }, &mut m); // set last_charging=false
        let a = decide(SystemState { charging: true, ..base() }, &mut m);
        assert!(has_motion(&a, "wave"));
        assert!(has_expr(&a, "happy"));
    }

    #[test]
    fn low_battery_is_sad() {
        let mut m = RuleMemory::default();
        let a = decide(SystemState { battery: Some(10.0), charging: false, ..base() }, &mut m);
        assert!(has_expr(&a, "sad"));
        assert!(has_say(&a, "low"));
    }

    #[test]
    fn top_of_hour_announces_once() {
        let mut m = RuleMemory::default();
        let a = decide(SystemState { minute: 0, hour: 9, ..base() }, &mut m);
        assert!(has_say(&a, "o'clock"));
        let a2 = decide(SystemState { minute: 0, hour: 9, ..base() }, &mut m);
        assert!(!has_say(&a2, "o'clock")); // not twice in the same hour
    }

    #[test]
    fn idle_is_relaxed() {
        let mut m = RuleMemory::default();
        let a = decide(SystemState { cpu: 10.0, ..base() }, &mut m);
        assert!(has_expr(&a, "relaxed"));
    }
}
