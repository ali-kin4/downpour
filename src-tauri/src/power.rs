//! "When the queue finishes, sleep / hibernate / shut down."
//!
//! This is the one feature in the app that can act on the machine rather than
//! on a file, so it is deliberately conservative:
//!
//! - It only ever fires on the busy-to-idle edge, never on an already-empty
//!   queue, or opening the app with nothing queued would shut the PC down.
//! - It only fires when something actually finished. A queue that drained
//!   because its only download failed in two seconds has not "finished", and
//!   putting the machine to sleep the instant a download 404s is indis-
//!   tinguishable from the app crashing the PC.
//! - It arms once and disarms itself: firing resets the setting to `Nothing`,
//!   so the machine cannot be put to sleep again tomorrow by a choice the user
//!   made for one overnight queue.
//! - Every action waits 60 seconds first, and "Cancel power action" in the menu
//!   calls it off, rather than pulling the floor out from under the user. Only
//!   shutdown has an on-screen timer, and that one is Windows' own; sleep and
//!   hibernate count down silently, so the menu item is the only way to stop
//!   them. A visible countdown for those two is still missing.
//! - Suspend is requested politely (`bForce = FALSE`), so drivers and apps get
//!   their notification window. A forced critical suspend skips it, and a
//!   machine that cannot service the transition that way does not go to sleep
//!   — it goes down hard, with no clean power-transition event behind it.

use downpour_core::settings::OnQueueComplete;
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};

/// Seconds of warning before the machine goes down. Long enough to notice and
/// cancel, short enough to be useful overnight.
const GRACE_SECONDS: u32 = 60;

/// Bumped every time a countdown is armed and every time one is cancelled.
///
/// A plain "cancelled" flag cannot tell "the user cancelled the countdown I am
/// in" from "the user cancelled an earlier one", and a stale flag silently eats
/// the next action. A countdown fires only if the generation it captured is
/// still current.
static COUNTDOWN_GENERATION: AtomicU64 = AtomicU64::new(0);

/// Whether a drain should trigger `action`.
///
/// Split out from the dispatch because the caller disarms the setting before
/// acting on it, and must disarm *only* when it acts. Folding this back into
/// `on_queue_drained` silently wipes the user's choice on the first download
/// that fails, and then nothing happens when a queue really does finish.
///
/// `completed` is the number of downloads that finished **in the run that just
/// drained**, not the number sitting in the list.
pub fn will_act(action: OnQueueComplete, completed: usize) -> bool {
    !matches!(action, OnQueueComplete::Nothing) && completed > 0
}

/// Runs the configured action, if a drain with these numbers warrants it.
pub fn on_queue_drained(app: &tauri::AppHandle, action: OnQueueComplete, completed: usize) {
    if matches!(action, OnQueueComplete::Nothing) {
        return;
    }
    if !will_act(action, completed) {
        tracing::info!(
            ?action,
            "queue drained with nothing completed; skipping the post-queue action"
        );
        return;
    }
    tracing::info!(
        ?action,
        completed,
        "queue drained; running post-queue action"
    );

    match action {
        OnQueueComplete::Nothing => {}
        OnQueueComplete::Exit => {
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                if let Some(state) = tauri::Manager::try_state::<crate::state::AppState>(&app) {
                    state.engine.shutdown().await;
                }
                app.exit(0);
            });
        }
        OnQueueComplete::Sleep => sleep(),
        OnQueueComplete::Hibernate => hibernate(),
        OnQueueComplete::Shutdown => shutdown(),
    }
}

/// Runs `action` after the grace period, unless the countdown was cancelled.
///
/// Detached so the event loop is never blocked for a minute.
fn after_grace(what: &'static str, action: fn()) {
    let armed = COUNTDOWN_GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
    tracing::info!(what, seconds = GRACE_SECONDS, "power countdown armed");
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_secs(GRACE_SECONDS as u64)).await;
        if COUNTDOWN_GENERATION.load(Ordering::SeqCst) != armed {
            tracing::info!(what, "power countdown cancelled before it fired");
            return;
        }
        action();
    });
}

#[cfg(windows)]
fn sleep() {
    // Sleep is reversible by moving the mouse, but getting there is not: the
    // transition tears down the display and USB power, and if it does not come
    // back the user is looking at a dead machine with no idea what asked for
    // it. So it gets the same cancellable countdown as the rest.
    after_grace("sleep", || {
        // SetSuspendState(bHibernate = 0, bForce = 0, bWakeupEventsDisabled = 0).
        // `bForce = 0` is load-bearing — see the module note on forced suspends.
        spawn_detached("rundll32.exe", &["powrprof.dll,SetSuspendState", "0,0,0"]);
    });
}

#[cfg(windows)]
fn hibernate() {
    // `shutdown /h` is immediate and has no delay flag, so the countdown is
    // ours. Hibernation writes RAM to disk and takes a real wake cycle to come
    // back from, so it gets the same grace period as a shutdown.
    after_grace("hibernate", || spawn_detached("shutdown", &["/h"]));
}

#[cfg(windows)]
fn shutdown() {
    // Dispatched straight away rather than through `after_grace`: `/t` is the
    // one countdown the user can actually see, and stacking a silent minute of
    // ours in front of it would only delay the warning.
    SHUTDOWN_ARMED.store(true, Ordering::SeqCst);
    spawn_detached(
        "shutdown",
        &[
            "/s",
            "/t",
            &GRACE_SECONDS.to_string(),
            "/c",
            "Downpour: downloads finished.",
        ],
    );
}

/// Whether a Windows-side `shutdown /t` countdown is running, so Cancel only
/// issues `shutdown /a` when there is something for it to abort. Called with
/// nothing pending it fails, and an error in the log that means "the cancel
/// worked" is worse than no line at all.
#[cfg(windows)]
static SHUTDOWN_ARMED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// Cancels a pending shutdown, hibernate or sleep countdown.
#[cfg(windows)]
pub fn abort_shutdown() {
    COUNTDOWN_GENERATION.fetch_add(1, Ordering::SeqCst);
    tracing::info!("power countdown cancelled by the user");
    if SHUTDOWN_ARMED.swap(false, Ordering::SeqCst) {
        spawn_detached("shutdown", &["/a"]);
    }
}

#[cfg(not(windows))]
fn sleep() {
    after_grace("sleep", || spawn_detached("systemctl", &["suspend"]));
}

#[cfg(not(windows))]
fn hibernate() {
    after_grace("hibernate", || spawn_detached("systemctl", &["hibernate"]));
}

#[cfg(not(windows))]
fn shutdown() {
    after_grace("shutdown", || spawn_detached("shutdown", &["-h", "+1"]));
}

#[cfg(not(windows))]
pub fn abort_shutdown() {
    COUNTDOWN_GENERATION.fetch_add(1, Ordering::SeqCst);
    spawn_detached("shutdown", &["-c"]);
}

/// Launches without waiting. A failure is logged, never propagated: the
/// downloads all finished successfully, and refusing to admit that because
/// `shutdown.exe` was missing would be absurd.
fn spawn_detached(program: &str, args: &[&str]) {
    match Command::new(program).args(args).spawn() {
        Ok(_) => tracing::info!(program, ?args, "power action dispatched"),
        Err(e) => tracing::error!(program, error = %e, "power action failed"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nothing_never_acts() {
        assert!(!will_act(OnQueueComplete::Nothing, 5));
        assert!(!will_act(OnQueueComplete::Nothing, 0));
    }

    #[test]
    fn a_run_that_completed_nothing_never_acts() {
        // The reported bug: a queue that drained because its only download
        // failed must not put the machine to sleep, and must not consume the
        // user's setting either.
        for action in [
            OnQueueComplete::Sleep,
            OnQueueComplete::Hibernate,
            OnQueueComplete::Shutdown,
            OnQueueComplete::Exit,
        ] {
            assert!(!will_act(action, 0), "{action:?} acted on an empty run");
            assert!(will_act(action, 1), "{action:?} ignored a real completion");
        }
    }
}
