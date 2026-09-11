# Installing Downpour

The short version: download `Downpour_x.y.z_x64-setup.exe` from the
[latest release](https://github.com/ali-kin4/downpour/releases/latest), run it,
click through **More info → Run anyway** on the SmartScreen warning, and you are
done. No administrator rights are needed.

This page is the long version — what the installer actually does, where it puts
things, and what to do when something goes wrong.

## Contents

1. [System requirements](#1-system-requirements)
2. [Which file to download](#2-which-file-to-download)
3. [The SmartScreen warning](#3-the-smartscreen-warning)
4. [Verifying the download](#4-verifying-the-download)
5. [What the installer does](#5-what-the-installer-does)
6. [Where your downloads go](#6-where-your-downloads-go)
7. [Pairing the browser extension](#7-pairing-the-browser-extension)
8. [Uninstalling](#8-uninstalling)
9. [Troubleshooting](#9-troubleshooting)

---

## 1. System requirements

| | |
|---|---|
| Operating system | **64-bit Windows 10 or Windows 11.** Windows only for 1.0 — see the note below. |
| Disk space | About 12 MB for the application. Your downloads need whatever they need. |
| Memory | Around **30 MB** working set at idle with the window open. |
| Administrator rights | **Not required** for `-setup.exe`. |
| WebView2 runtime | Ships with Windows 11. On Windows 10 the installer fetches it silently if it is missing, so a first install on such a machine needs an internet connection. |

**About "Windows only".** The download engine (`downpour-core`) is portable
Rust with no platform-specific code, and its test suite passes anywhere Rust
runs. The desktop shell around it is not tested on macOS or Linux, and there are
no builds for them. Treat Downpour as a Windows application; a port is possible,
but it has not been done and is not promised.

---

## 2. Which file to download

The [releases page](https://github.com/ali-kin4/downpour/releases/latest)
carries three files:

| File | Use it when |
|---|---|
| `Downpour_x.y.z_x64-setup.exe` | **This is the one you want.** An NSIS installer that installs for your user account only and never prompts for administrator rights. |
| `Downpour_x.y.z_x64_en-US.msi` | Managed deployment — Group Policy, Intune, or anything that expects an MSI. It follows the ordinary MSI conventions for that, which are not the same as the per-user setup above. |
| `checksums.txt` | SHA-256 hashes of both installers, in `sha256sum` format. |

Steps, for the `-setup.exe`:

1. Open the [latest release](https://github.com/ali-kin4/downpour/releases/latest).
2. Expand **Assets** and click `Downpour_x.y.z_x64-setup.exe`. It is around 4 MB,
   so it lands in a second or two.
3. Run it. Windows will show a warning — see the next section.
4. The installer asks where to install (the default is fine) and which Start Menu
   folder to use, then finishes with **Create desktop shortcut** and **Run
   Downpour** offered on the last page. There is no UAC prompt at any point.
5. Downpour opens, creates its download folders, and puts an icon in the tray.

---

## 3. The SmartScreen warning

**You will see this. It is expected, and here is exactly why.**

Downpour's installers are **not code-signed**. An Authenticode certificate from
a public CA costs a few hundred dollars a year and, for an EV certificate,
requires a hardware token and a registered legal entity. This is an unfunded
personal project, so the binaries go out unsigned.

Windows treats any unsigned executable that few people have run before as
unknown, and Microsoft Defender SmartScreen puts a full-screen blue panel in
front of it:

> **Windows protected your PC**
> Microsoft Defender SmartScreen prevented an unrecognised app from starting.
> Running this app might put your PC at risk.

What the buttons do:

| Button | What happens |
|---|---|
| **Don't run** | The default. The installer is discarded and nothing is installed. |
| **More info** | Expands the panel to show the app name and publisher, and reveals a second button. Nothing is executed by clicking this. |
| **Run anyway** | Appears only after **More info**. Runs the installer. |

So: **More info**, then **Run anyway**.

**Do not just click through it on faith.** A scary warning you are told to
ignore is exactly how malware gets installed, and "the README said it was fine"
is not verification. If you want to be sure the file you have is the file that
was built:

- Check the SHA-256 against `checksums.txt` — [next section](#4-verifying-the-download).
- Confirm the file came from `github.com/ali-kin4/downpour/releases`. Every
  release asset is built by a GitHub Actions runner from a tagged commit; the
  workflow is [`.github/workflows/release.yml`](../.github/workflows/release.yml)
  and the log for the run that produced your file is public.
- Upload it to [VirusTotal](https://www.virustotal.com/) if you want a second
  opinion — and read the [antivirus section](#antivirus-flags-the-installer)
  below before you panic at one or two hits.

The warning fades over time as more people install the same file and SmartScreen
builds reputation for it. It comes back with every new version, because
reputation attaches to the exact binary.

---

## 4. Verifying the download

Every release includes `checksums.txt` in `sha256sum` format. In PowerShell:

```powershell
Get-FileHash .\Downpour_0.1.0_x64-setup.exe -Algorithm SHA256
```

Compare the `Hash` column, case-insensitively, with the matching line in
`checksums.txt`. If they differ, delete the file and download it again; if they
differ a second time, open an issue rather than running it.

This proves the file was not altered between GitHub and your disk. It does not
prove anything about who built it — that is what code signing would do, and
Downpour does not have it yet.

---

## 5. What the installer does

### Files

| Path | Contents |
|---|---|
| `%LOCALAPPDATA%\Downpour\` | `Downpour.exe`, its resources, and `uninstall.exe`. This is the default; the installer's **Destination Folder** page lets you change it. |
| `%APPDATA%\com.alikin4.downpour\` | `downpour.db` — the SQLite database holding your queue, your settings and your pairing token. Also `tools\yt-dlp.exe`, if you ever choose to install that. |
| `%LOCALAPPDATA%\com.alikin4.downpour\` | The WebView2 cache for the app's window. Disposable; deleting it costs nothing. |

If you would rather see real paths: `%LOCALAPPDATA%` is
`C:\Users\<you>\AppData\Local` and `%APPDATA%` is
`C:\Users\<you>\AppData\Roaming`.

### Shortcuts and registry

- A **desktop shortcut**, `Downpour.lnk`, created by
  [`src-tauri/installer/hooks.nsh`](../src-tauri/installer/hooks.nsh) and
  deleted again on uninstall. An orphaned desktop icon pointing at a deleted
  binary is the classic sign of a careless installer.
- A **Start Menu** entry in a `Downpour` folder.
- An **Add or remove programs** entry, written under
  `HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\Uninstall\` —
  `HKCU`, not `HKLM`, which is exactly why no elevation is needed.
- Nothing under `HKLM`. No services, no scheduled tasks, no drivers, no shell
  extensions.
- **Start with Windows** is off by default. Turning it on in Settings writes a
  value under `HKCU\...\CurrentVersion\Run`, and uninstalling removes it.

### Changing the install location

Use the installer's **Destination Folder** page. From a script or a deployment
tool, NSIS's own flags apply:

```powershell
# Silent install into a chosen folder
.\Downpour_x.y.z_x64-setup.exe /S /D=C:\Tools\Downpour
```

`/S` installs silently, `/P` installs with a progress window but no questions,
`/R` starts the app afterwards, and `/D=` sets the directory — unquoted, even if
the path contains spaces, and always the **last** argument on the line. That is
an NSIS convention, not a Downpour one.

A silent or passive install skips the finish page, so it creates the desktop
shortcut without asking.

---

## 6. Where your downloads go

The default download folder is:

```
%USERPROFILE%\Downloads\Downpour
```

On the **first run only**, Downpour creates that folder and six category
subfolders inside it, the way IDM does:

```
Downloads\Downpour\Video        mp4, mkv, avi, mov, webm, …
Downloads\Downpour\Music        mp3, flac, wav, aac, opus, …
Downloads\Downpour\Pictures     jpg, png, gif, webp, heic, …
Downloads\Downpour\Documents    pdf, docx, xlsx, epub, txt, …
Downloads\Downpour\Compressed   zip, rar, 7z, tar, iso, …
Downloads\Downpour\Programs     exe, msi, apk, deb, jar, …
```

Three things about this are deliberate:

- It runs **once**, guarded by a flag in the database. A folder you already have
  is reused and never touched. A folder you delete on purpose does not come back
  on the next launch.
- Every folder name and every extension list is editable in
  **Settings → Downloads**, and the whole behaviour can be switched off — files
  then land in the download folder root. If folders go missing later, Settings
  has a "create the missing folders" button that shows you each resolved path
  first.
- If the download folder itself cannot be created, the flag is *not* set, so the
  next launch tries again. A drive that was not mounted yet is not a permanent
  failure.

Changing the download folder later does not move anything already downloaded,
and does not re-run first-run setup in the new location.

---

## 7. Pairing the browser extension

The extension is not in any store. It ships in this repository as an unpacked
Manifest V3 extension, and it works in Chrome, Edge, Brave, Opera and Vivaldi.

The full walkthrough is in [`extension/README.md`](../extension/README.md). The
outline:

1. **Run Downpour at least once** so it generates a pairing token, and leave it
   running.
2. Open `chrome://extensions` (or `edge://extensions`, and so on), turn on
   **Developer mode**, click **Load unpacked**, and select the `extension`
   folder. Keep that folder where it is — the browser loads it from that path
   every time it starts.
3. In Downpour, open **Settings → Browser integration** and reveal and copy the
   64-character pairing token.
4. On the extension's settings page, paste it into **Pairing token**, press
   **Save token**, then **Test connection**. It reports reachability and
   authentication separately, because they fail for different reasons and need
   different fixes.

The app listens on `127.0.0.1` only, on the first free port in the range
**47113–47123**. Everything except the unauthenticated `GET /health` probe
requires the token. Regenerating the token in Settings invalidates the old one
immediately, and the extension stops sending anything until you re-pair.

---

## 8. Uninstalling

Any of these work:

- **Settings → Apps → Installed apps → Downpour → Uninstall**
- **Control Panel → Programs and Features → Downpour**
- Run `%LOCALAPPDATA%\Downpour\uninstall.exe` directly

Close Downpour first, including the tray icon — the app minimises to the tray by
default, so closing the window does not close the app.

The confirmation page carries a checkbox, worded along the lines of **"Delete
application data"**. It decides everything that matters:

| | Checkbox **off** (default) | Checkbox **on** |
|---|---|---|
| `%LOCALAPPDATA%\Downpour\` (the program) | Removed | Removed |
| Desktop and Start Menu shortcuts | Removed | Removed |
| Add/Remove Programs entry | Removed | Removed |
| The `Run` registry value, if autostart was on | Removed | Removed |
| `%APPDATA%\com.alikin4.downpour\` — **your queue, settings and pairing token** | **Kept** | Removed |
| `%LOCALAPPDATA%\com.alikin4.downpour\` — WebView2 cache | **Kept** | Removed |

**Your downloaded files are never touched, either way.** Neither are partial
downloads: a `.dpart` / `.dpmeta` pair sitting in your download folder is left
exactly where it is. Delete those by hand if you want them gone — they are of no
use to anything but Downpour.

So the two recipes are:

- **Reinstalling later and keeping your queue**: leave the checkbox alone.
- **Removing every trace**: tick the checkbox, then delete
  `%USERPROFILE%\Downloads\Downpour` if you do not want the files, and remove
  the unpacked extension from `chrome://extensions`.

---

## 9. Troubleshooting

### "Windows protected your PC"

Covered in full [above](#3-the-smartscreen-warning). **More info → Run anyway**.
Verify the checksum first if you would rather be certain than trusting.

If **Run anyway** does not appear after **More info**, SmartScreen is in *block*
mode rather than *warn* mode, which an administrator or a security policy can
set. The setting lives under **Windows Security → App & browser control →
Reputation-based protection settings → Check apps and files**. On a machine you
do not administer, ask whoever does — do not try to work around the policy.

### Antivirus flags the installer

A brand-new, unsigned executable that downloads files from the internet is an
almost perfect description of both a download manager and a malware dropper, so
heuristic engines occasionally flag Downpour. On VirusTotal, a handful of hits
from engines you have never heard of, with generic names like `Unsafe`,
`Suspicious.ML` or `Trojan.Generic`, is the ordinary signature of a new unsigned
binary. Dozens of hits, including the major engines, would be a real finding —
please report that as a security issue.

What to do:

1. **Check the SHA-256 against `checksums.txt` first.** If it does not match,
   stop; you do not have the file that was built.
2. If it matches, the detection is a false positive. Add an exclusion for
   `%LOCALAPPDATA%\Downpour\`, or submit the file to your vendor as a false
   positive — they do act on those.
3. If the file disappears *after* installation and Downpour will not start, it
   has been quarantined. Restore it and add the exclusion.

The real fix is code signing, which is on the list and not done.

### The browser extension cannot find the app

The popup says **"Downpour is not running"** when nothing answered on
`127.0.0.1:47113–47123`.

1. **Is Downpour actually running?** It minimises to the tray by default. Look
   for the tray icon before concluding it is closed.
2. **Is browser integration enabled?** **Settings → Browser integration** has a
   switch, and a status badge showing the port that was actually bound.
3. **Is every port in the range taken?** Downpour tries 47113 and the ten ports
   after it, in order, and gives up if all eleven are busy. Check with:

   ```powershell
   Get-NetTCPConnection -State Listen -LocalPort 47113..47123 |
     Select-Object LocalAddress, LocalPort, OwningProcess
   ```

   Match `OwningProcess` against `Get-Process -Id <pid>`. If something else owns
   the range, change the base port in **Settings → Browser integration**, restart
   Downpour, and press **Re-check connection** in the extension — it rediscovers
   the port by itself.
4. **Is a firewall filtering loopback?** Unusual, but some endpoint-security
   products do. Downpour never binds to any interface except `127.0.0.1`, so
   allowing the app through the *network* firewall will not help; the rule has to
   permit local loopback traffic.

If the badge shows a red `!` instead, the app is reachable and the **token** is
wrong. Copy it again from **Settings → Browser integration**.

### Downloads fail behind a corporate proxy

Downpour has no proxy setting of its own. Two separate things break here, with
different symptoms and different answers.

**1. The proxy is not being used at all.** Downpour reads the standard proxy
environment variables and nothing else:

| Variable | Effect |
|---|---|
| `HTTPS_PROXY` / `https_proxy` | Proxy for `https://` requests — the one that matters. |
| `HTTP_PROXY` / `http_proxy` | Proxy for `http://` requests. |
| `ALL_PROXY` / `all_proxy` | Fallback for both. |
| `NO_PROXY` / `no_proxy` | Comma-separated hosts, domain suffixes and CIDR ranges to reach directly. |

```powershell
# For your user account, permanently. Restart Downpour afterwards.
[Environment]::SetEnvironmentVariable(
  'HTTPS_PROXY', 'http://proxy.example.com:8080', 'User')
[Environment]::SetEnvironmentVariable(
  'NO_PROXY', 'localhost,127.0.0.1,.internal.example.com', 'User')
```

A proxy configured **only** in Internet Options, or through a PAC script or WPAD
autodiscovery, is *not* picked up: this build does not compile in reqwest's
Windows system-proxy detection. So if your browser works and Downpour does not,
this is the first thing to check. Read the proxy host and port out of the PAC
file and set them as environment variables.

If the proxy needs credentials, put them in the URL —
`http://user:password@proxy.example.com:8080`. That stores a password in an
environment variable in plain text; decide whether that is acceptable on your
machine before doing it.

**2. The proxy inspects TLS, and its certificate is not trusted.** This one is a
genuine limitation rather than a misconfiguration, and it is worth stating
plainly.

Downpour's HTTP client uses **rustls with a bundled Mozilla root store**
(`webpki-roots`). It does **not** read the Windows certificate store. A
TLS-intercepting proxy — Zscaler, Netskope, a Palo Alto or Fortinet appliance,
most products sold as "SSL inspection" — presents a certificate signed by a
private corporate root CA that your administrator installed into Windows. Chrome
and Edge trust it because they use the Windows store. Downpour does not see it,
so every HTTPS download fails with a certificate error while the same URL
downloads fine in the browser.

There is **no setting in Downpour that fixes this today**, and no environment
variable that overrides the root store. The options are:

- Have the network team exempt the hosts you download from, so they are not
  intercepted.
- Use Downpour on a network that is not inspected.
- Build from source with reqwest's `rustls-tls-native-roots` feature in place of
  `rustls-tls`, which makes it read the Windows store. That is a one-line change
  in `Cargo.toml` and produces an unofficial build.

If you hit this, please
[open an issue](https://github.com/ali-kin4/downpour/issues) — it is worth
knowing how many people are affected before deciding how to fix it properly.

### A download is stuck at 0%, or runs on one connection

Open the item and look at what the probe reported. Two common and benign causes:

- **The server does not support byte ranges.** Downpour proves range support with
  a real ranged request rather than trusting an `Accept-Ranges` header, and falls
  back to a single connection when the server hands back the whole file instead.
  That is correct behaviour, not a bug — the alternative is writing a corrupt
  file that passes every length check.
- **A session-gated link.** If the file arrives as a few KB of HTML, the server
  wanted a cookie. Use the browser extension, which hands the download over with
  the browser's `Cookie`, `Referer` and `User-Agent` attached.

### Resume refuses to continue

If the server's `ETag` or `Last-Modified` no longer matches what was recorded
when the download started, Downpour stops rather than splicing two different
versions of a file into one plausible-looking, corrupt result. The file on the
server changed. Start the download again from the beginning.

### Something else

Open an issue at
[github.com/ali-kin4/downpour/issues](https://github.com/ali-kin4/downpour/issues).
Include your Windows version, the Downpour version (**Help → About**), and — most
usefully — the URL, or at least the host. Most download bugs are really
server-behaviour bugs, and a reproducing host is worth more than a stack trace.

For anything security-related, use
[GitHub Security Advisories](https://github.com/ali-kin4/downpour/security/advisories/new)
rather than a public issue. See [SECURITY.md](../SECURITY.md).
