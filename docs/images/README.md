# Screenshots

Images referenced by the project README.

| File | Status | What it shows |
|---|---|---|
| `screenshot.png` | **present** | The hero shot at the top of the README: the main window in the dark theme with a real queue — downloads running with live speeds, plus queued, scheduled, paused, failed and completed rows, the sidebar expanded and the status bar showing total throughput. |
| `screenshot-light.png` | **not added yet** | The same window in the light theme. Optional. If you add it, put it in the README beside the dark one — a pair is what makes the "follows Windows" claim believable. |

Anything else is not referenced anywhere and is not worth capturing.

## If you replace `screenshot.png`

- Capture the window at its default size (**1180 × 760**, set in
  `src-tauri/tauri.conf.json`) or larger, at 100% display scaling. A
  150%-scaled capture resampled down looks soft.
- PNG, not JPEG. Keep it under about 500 KB — `oxipng -o4` or `pngquant` halves
  these with no visible loss.
- Crop to the window; no wallpaper, no taskbar.
- Check the shot for anything you would not want on a public front page: real
  filenames, real URLs, a visible pairing token, a username in a path. Use a
  throwaway download folder and well-known public files.
- **No mockups or renders.** A screenshot that does not match the app is worse
  than no screenshot at all.
- Update the README's alt text if the contents change — it currently describes
  seven downloads in various states.
