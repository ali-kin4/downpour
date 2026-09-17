//! System tray icon and menu.
//!
//! The tray is not decoration: with `close_to_tray` on, it is the only way back
//! into a running app, and the tooltip is where a user checks progress without
//! restoring the window.
//!
//! It is also where the per-download progress boxes are chosen from. The
//! "Downloads" submenu lists what is still in flight, and picking one opens a
//! small always-on-top box for that download alone -- IDM's habit, and the
//! reason the submenu is rebuilt from the engine rather than written once at
//! startup.

use crate::download_window;
use crate::state::AppState;
use downpour_core::model::{DownloadItem, DownloadStatus};
use downpour_core::speed::format_speed;
use downpour_core::Engine;
use std::time::Duration;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, Runtime};

/// One row of the downloads submenu: the id it opens, and the text it shows.
type Entry = (String, String);

/// Long lists stop being a menu and start being a list. The main window is one
/// click away and is the right place to read forty rows.
const MAX_ENTRIES: usize = 12;

pub fn build<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    let menu = build_menu(app, &entries(app))?;

    TrayIconBuilder::with_id("main")
        .icon(app.default_window_icon().cloned().expect("bundled icon"))
        .tooltip("Downpour")
        .menu(&menu)
        // Left-clicking the icon should open the window, which is what every
        // Windows user expects; without this the menu is the only way in.
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| {
            let id = event.id().as_ref();

            // The download rows carry their window label as their menu id, so
            // this is the only place that has to know they are not fixed
            // items. It has to run before the match: `match` cannot pattern
            // on a prefix, and these ids are one per download.
            if let Some(download_id) = download_window::id_from_label(id) {
                let name = app
                    .try_state::<AppState>()
                    .and_then(|state| state.engine.get(download_id))
                    .map(|item| item.filename)
                    .unwrap_or_else(|| "download".to_string());
                if let Err(e) = download_window::open(app, download_id, &name) {
                    tracing::warn!(error = %e, id = download_id, "could not open the download box");
                }
                return;
            }

            match id {
                "show" => show_window(app),
                "pause_all" => {
                    if let Some(state) = app.try_state::<AppState>() {
                        let _ = state.engine.pause_all();
                    }
                }
                "resume_all" => {
                    if let Some(state) = app.try_state::<AppState>() {
                        let _ = state.engine.resume_all();
                    }
                }
                "quit" => {
                    let app = app.clone();
                    // Pause cleanly first so every sidecar is flushed and the next
                    // launch resumes instead of restarting from zero.
                    tauri::async_runtime::spawn(async move {
                        if let Some(state) = app.try_state::<AppState>() {
                            state.engine.shutdown().await;
                        }
                        app.exit(0);
                    });
                }
                _ => {}
            }
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_window(tray.app_handle());
            }
        })
        .build(app)?;

    spawn_tooltip_updater(app.clone());
    spawn_menu_updater(app.clone());
    Ok(())
}

fn show_window<R: Runtime>(app: &AppHandle<R>) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

// ---------------------------------------------------------------------------
// The menu
// ---------------------------------------------------------------------------

fn build_menu<R: Runtime>(app: &AppHandle<R>, entries: &[Entry]) -> tauri::Result<Menu<R>> {
    let show = MenuItem::with_id(app, "show", "Open Downpour", true, None::<&str>)?;
    let pause_all = MenuItem::with_id(app, "pause_all", "Pause all", true, None::<&str>)?;
    let resume_all = MenuItem::with_id(app, "resume_all", "Resume all", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit Downpour", true, None::<&str>)?;
    let sep1 = PredefinedMenuItem::separator(app)?;
    let sep2 = PredefinedMenuItem::separator(app)?;
    let sep3 = PredefinedMenuItem::separator(app)?;

    // An empty submenu opens as an empty grey rectangle on Windows, which
    // reads as a bug rather than as an answer. A disabled line says the same
    // thing and looks intentional.
    let downloads = Submenu::with_id(app, "downloads", "Downloads", true)?;
    if entries.is_empty() {
        let none = MenuItem::with_id(
            app,
            "no_downloads",
            "Nothing downloading",
            false,
            None::<&str>,
        )?;
        downloads.append(&none)?;
    } else {
        for (id, text) in entries {
            let item = MenuItem::with_id(app, id.as_str(), text, true, None::<&str>)?;
            downloads.append(&item)?;
        }
    }

    Menu::with_items(
        app,
        &[
            &show,
            &sep1,
            &downloads,
            &sep2,
            &pause_all,
            &resume_all,
            &sep3,
            &quit,
        ],
    )
}

/// What the submenu offers a box for.
///
/// Everything still in flight, not only what is transferring this second: a
/// download you paused is exactly the one you are most likely to want a box
/// for, and a list that emptied itself the moment you pressed pause would be
/// useless. Finished and failed downloads are left out -- there is nothing to
/// watch, and the main window is where you deal with them.
fn entries<R: Runtime>(app: &AppHandle<R>) -> Vec<Entry> {
    let Some(state) = app.try_state::<AppState>() else {
        return Vec::new();
    };
    entries_from(&state.engine.list())
}

fn entries_from(items: &[DownloadItem]) -> Vec<Entry> {
    let mut live: Vec<&DownloadItem> = items.iter().filter(|i| rank(i.status).is_some()).collect();
    live.sort_by_key(|i| (rank(i.status).unwrap_or(u8::MAX), i.sequence));
    live.truncate(MAX_ENTRIES);
    live.iter()
        .map(|i| {
            (
                download_window::label_for(&i.id),
                entry_text(&i.filename, i.status),
            )
        })
        .collect()
}

/// Transferring first, then whatever is waiting -- the same order the compact
/// panel pages through, so the two never disagree about what matters.
///
/// `None` keeps a download out of the menu entirely. That covers the terminal
/// states, which have nothing left to watch, and `Idle` -- a download that was
/// added without being started is one you deal with in the main window, and it
/// is the one state the compact panel leaves out too.
fn rank(status: DownloadStatus) -> Option<u8> {
    match status {
        DownloadStatus::Running => Some(0),
        DownloadStatus::Probing => Some(1),
        DownloadStatus::Queued => Some(2),
        DownloadStatus::Scheduled => Some(3),
        DownloadStatus::Paused => Some(4),
        _ => None,
    }
}

/// Deliberately no percentage.
///
/// The menu is replaced whenever this text changes, and a live percentage
/// would replace it every progress tick -- including while the user has the
/// submenu open under the pointer. The name and the state are what you need to
/// pick the right row; the box you open is where the numbers live.
fn entry_text(filename: &str, status: DownloadStatus) -> String {
    let name = escape_mnemonics(&elide_middle(filename, 44));
    match status {
        DownloadStatus::Probing => format!("{name} — connecting"),
        DownloadStatus::Queued => format!("{name} — waiting"),
        DownloadStatus::Scheduled => format!("{name} — scheduled"),
        DownloadStatus::Paused => format!("{name} — paused"),
        _ => name,
    }
}

/// Windows menus read `&` as the marker for a keyboard mnemonic, so
/// `Tom & Jerry.mkv` would arrive as `Tom  Jerry.mkv` with the J underlined.
/// Doubling it is the escape; elsewhere it would just be two ampersands.
fn escape_mnemonics(text: &str) -> String {
    if cfg!(windows) {
        text.replace('&', "&&")
    } else {
        text.to_string()
    }
}

/// Shortens from the middle, because the extension is the half that identifies
/// a file when the stem is a forty-character release name.
fn elide_middle(text: &str, max: usize) -> String {
    let chars: Vec<char> = text.chars().collect();
    if chars.len() <= max || max < 5 {
        return text.to_string();
    }
    let head = (max - 1) / 2;
    let tail = max - 1 - head;
    let mut out: String = chars[..head].iter().collect();
    out.push('…');
    out.extend(chars[chars.len() - tail..].iter());
    out
}

/// Keeps the downloads submenu in step with the queue.
///
/// Driven by the event stream rather than a timer, so a download added from
/// the browser is in the menu by the time the user reaches the tray. The
/// entries are compared before anything is rebuilt: a progress tick changes
/// nothing the menu shows, and swapping the menu out from under an open
/// submenu for no reason is worth avoiding.
fn spawn_menu_updater<R: Runtime>(app: AppHandle<R>) {
    let Some(state) = app.try_state::<AppState>() else {
        return;
    };
    let engine: Engine = state.engine.clone();
    let mut rx = engine.subscribe();

    tauri::async_runtime::spawn(async move {
        let mut last = entries_from(&engine.list());
        while rx.recv().await.is_ok() {
            let next = entries_from(&engine.list());
            if next == last {
                continue;
            }
            last = next;

            // `Menu::new` and `set_menu` both hop to the main thread on their
            // own, which is why this can be built from a runtime worker.
            let menu = match build_menu(&app, &last) {
                Ok(menu) => menu,
                Err(e) => {
                    tracing::warn!(error = %e, "could not rebuild the tray menu");
                    continue;
                }
            };
            if let Some(tray) = app.tray_by_id("main") {
                if let Err(e) = tray.set_menu(Some(menu)) {
                    tracing::warn!(error = %e, "could not install the tray menu");
                }
            }
        }
    });
}

/// Keeps the tray tooltip showing live totals.
///
/// Two seconds rather than the engine's 500ms: the tooltip is only visible on
/// hover, and rewriting it four times a second is pure wasted syscalls.
fn spawn_tooltip_updater<R: Runtime>(app: AppHandle<R>) {
    tauri::async_runtime::spawn(async move {
        let mut last = String::new();
        loop {
            tokio::time::sleep(Duration::from_secs(2)).await;

            let Some(state) = app.try_state::<AppState>() else {
                continue;
            };
            let stats = state.engine.stats();

            let text = if stats.running > 0 {
                format!(
                    "Downpour — {} downloading at {}",
                    stats.running,
                    format_speed(stats.total_speed_bps)
                )
            } else if stats.queued > 0 || stats.scheduled > 0 {
                format!("Downpour — {} waiting", stats.queued + stats.scheduled)
            } else {
                "Downpour — idle".to_string()
            };

            if text == last {
                continue;
            }
            last = text.clone();
            if let Some(tray) = app.tray_by_id("main") {
                let _ = tray.set_tooltip(Some(&text));
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The menu offers a box for anything still in flight and nothing else.
    /// Tested through `rank` rather than by building `DownloadItem`s, so this
    /// stays honest when the engine's model grows a field.
    #[test]
    fn finished_downloads_are_not_listed() {
        for status in [
            DownloadStatus::Completed,
            DownloadStatus::Failed,
            DownloadStatus::Cancelled,
            DownloadStatus::Idle,
        ] {
            assert_eq!(rank(status), None, "{status:?} should not reach the menu");
        }
        for status in [
            DownloadStatus::Running,
            DownloadStatus::Probing,
            DownloadStatus::Queued,
            DownloadStatus::Scheduled,
            DownloadStatus::Paused,
        ] {
            assert!(rank(status).is_some(), "{status:?} should reach the menu");
        }
    }

    #[test]
    fn transferring_downloads_come_first() {
        assert!(rank(DownloadStatus::Running) < rank(DownloadStatus::Queued));
        assert!(rank(DownloadStatus::Queued) < rank(DownloadStatus::Paused));
    }

    /// A row's menu id has to be the window label it opens, or picking it
    /// opens nothing.
    #[test]
    fn menu_ids_are_window_labels() {
        let id = "3f2a1b4c-0d5e-4f60-9a7b-8c9d0e1f2a3b";
        assert_eq!(
            download_window::id_from_label(&download_window::label_for(id)),
            Some(id)
        );
    }

    #[test]
    fn waiting_downloads_say_so() {
        assert_eq!(entry_text("a.zip", DownloadStatus::Running), "a.zip");
        assert_eq!(
            entry_text("a.zip", DownloadStatus::Paused),
            "a.zip — paused"
        );
    }

    #[test]
    fn long_names_keep_their_extension() {
        let elided = elide_middle(&format!("{}.tar.gz", "x".repeat(80)), 20);
        assert_eq!(elided.chars().count(), 20);
        assert!(elided.ends_with(".gz"));
    }

    #[test]
    fn short_names_are_left_alone() {
        assert_eq!(elide_middle("a.zip", 44), "a.zip");
    }

    #[test]
    fn ampersands_survive_the_menu() {
        let escaped = escape_mnemonics("Tom & Jerry.mkv");
        if cfg!(windows) {
            assert_eq!(escaped, "Tom && Jerry.mkv");
        } else {
            assert_eq!(escaped, "Tom & Jerry.mkv");
        }
    }
}
