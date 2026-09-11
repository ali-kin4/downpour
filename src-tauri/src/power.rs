//! "When the queue finishes, sleep / hibernate / shut down."
//!
//! This is the one feature in the app that can act on the machine rather than
//! on a file, so it is deliberately conservative:
//!
//! - It only ever fires on the busy-to-idle edge, never on an already-empty
//!   queue, or opening the app with nothing queued would shut the PC down.
//! - It arms once and disarms itself, so a later drain does not fire again
//!   without the user re-selecting the action.
//! - Shutdown and hibernate use a visible 60-second countdown that the user can
//!   cancel, rather than pulling the floor out from under them.

use downpour_core::settings::OnQueueComplete;
use std::process::Command;

/// Seconds of warning before the machine goes down. Long enough to notice and
/// cancel, short enough to be useful overnight.
const GRACE_SECONDS: u32 = 60;

pub fn on_queue_drained(app: &tauri::AppHandle, action: OnQueueComplete, completed: usize) {
    if matches!(action, OnQueueComplete::Nothing) {
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

#[cfg(windows)]
fn sleep() {
    // SetSuspendState(hibernate=0, force=0, wakeupEventsDisabled=0).
    // Note this suspends without a countdown: sleep is instantly reversible by
    // moving the mouse, so a grace period would be pointless friction.
    spawn_detached("rundll32.exe", &["powrprof.dll,SetSuspendState", "0,1,0"]);
}

#[cfg(windows)]
fn hibernate() {
    spawn_detached("shutdown", &["/h"]);
}

#[cfg(windows)]
fn shutdown() {
    // `/t` gives the user a cancellable window; `shutdown /a` aborts it.
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

/// Cancels a pending shutdown or hibernate countdown.
#[cfg(windows)]
pub fn abort_shutdown() {
    spawn_detached("shutdown", &["/a"]);
}

#[cfg(not(windows))]
fn sleep() {
    spawn_detached("systemctl", &["suspend"]);
}

#[cfg(not(windows))]
fn hibernate() {
    spawn_detached("systemctl", &["hibernate"]);
}

#[cfg(not(windows))]
fn shutdown() {
    spawn_detached("shutdown", &["-h", "+1"]);
}

#[cfg(not(windows))]
pub fn abort_shutdown() {
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
