/**
 * File-type identity: icon and colour.
 *
 * A download list is scanned, not read. Giving each kind of file a distinct
 * glyph *and* a distinct hue means a user finds the installer among forty rows
 * by colour before they have read a single filename — which is the whole point
 * of an icon column.
 *
 * The colours are deliberately desaturated so a list of forty rows does not
 * look like a paint chart, and each one is checked to stay legible on both the
 * light and dark surface tokens.
 */

import {
  Archive,
  Binary,
  BookOpen,
  Braces,
  Clapperboard,
  Database,
  Disc3,
  FileAudio,
  FileCode,
  FileImage,
  FileSpreadsheet,
  FileText,
  FileType,
  Film,
  Image,
  MonitorCog,
  Music,
  Package,
  Presentation,
  Settings2,
  Terminal,
  Type,
  type LucideIcon,
} from "lucide-react";

export interface FileKind {
  /** Broad group, matching the category folders downloads are sorted into. */
  group:
    | "video"
    | "audio"
    | "image"
    | "document"
    | "archive"
    | "program"
    | "code"
    | "data"
    | "font"
    | "disc"
    | "other";
  icon: LucideIcon;
  /** Hex, used at low opacity for the tile and at full strength for the glyph. */
  colour: string;
  label: string;
}

const KINDS: Record<string, FileKind> = {};

function register(
  group: FileKind["group"],
  icon: LucideIcon,
  colour: string,
  label: string,
  extensions: string[],
) {
  for (const ext of extensions) {
    KINDS[ext] = { group, icon, colour, label };
  }
}

// --- Video -------------------------------------------------------------
register("video", Clapperboard, "#8b5cf6", "Video", [
  "mp4", "mkv", "mov", "avi", "wmv", "flv", "webm", "m4v", "mpg", "mpeg",
  "3gp", "divx", "rmvb", "ogv", "vob", "mts", "m2ts", "ts",
]);
register("video", Film, "#8b5cf6", "Subtitles", ["srt", "vtt", "ass", "sub", "idx"]);

// --- Audio -------------------------------------------------------------
register("audio", Music, "#ec4899", "Audio", [
  "mp3", "aac", "ogg", "opus", "m4a", "wma", "amr", "mid", "midi",
]);
register("audio", FileAudio, "#ec4899", "Lossless audio", [
  "flac", "wav", "alac", "aiff", "ape", "dsf", "wv",
]);

// --- Images ------------------------------------------------------------
register("image", Image, "#f59e0b", "Image", [
  "jpg", "jpeg", "png", "gif", "webp", "bmp", "avif", "heic", "heif", "ico",
]);
register("image", FileImage, "#f59e0b", "Vector or raw image", [
  "svg", "eps", "ai", "psd", "xcf", "raw", "cr2", "cr3", "nef", "arw", "dng",
  "tiff", "tif",
]);

// --- Documents ---------------------------------------------------------
register("document", FileType, "#ef4444", "PDF", ["pdf"]);
register("document", FileText, "#3b82f6", "Document", [
  "doc", "docx", "odt", "rtf", "txt", "md", "tex", "log", "nfo", "readme",
]);
register("document", FileSpreadsheet, "#10b981", "Spreadsheet", [
  "xls", "xlsx", "ods", "csv", "tsv",
]);
register("document", Presentation, "#f97316", "Presentation", [
  "ppt", "pptx", "odp", "key",
]);
register("document", BookOpen, "#6366f1", "E-book", [
  "epub", "mobi", "azw", "azw3", "djvu", "fb2", "cbz", "cbr",
]);

// --- Archives ----------------------------------------------------------
register("archive", Archive, "#eab308", "Archive", [
  "zip", "rar", "7z", "tar", "gz", "tgz", "bz2", "xz", "zst", "lz", "lzma",
  "arj", "cab", "z", "wim",
]);

// --- Disc images -------------------------------------------------------
register("disc", Disc3, "#a855f7", "Disc image", [
  "iso", "img", "dmg", "vhd", "vhdx", "vmdk", "bin", "cue", "nrg", "mdf",
]);

// --- Programs ----------------------------------------------------------
register("program", MonitorCog, "#0ea5e9", "Windows program", [
  "exe", "msi", "msix", "appx", "appxbundle",
]);
register("program", Package, "#0ea5e9", "Package", [
  "deb", "rpm", "pkg", "apk", "appimage", "snap", "flatpak", "jar", "run",
  "crx", "xpi", "vsix", "nupkg", "whl",
]);
register("program", Terminal, "#64748b", "Script", [
  "bat", "cmd", "ps1", "sh", "bash", "zsh", "vbs", "reg",
]);

// --- Code and data -----------------------------------------------------
register("code", FileCode, "#22d3ee", "Source code", [
  "html", "htm", "css", "scss", "js", "mjs", "cjs", "ts", "tsx", "jsx", "py",
  "rs", "go", "java", "c", "h", "cpp", "hpp", "cs", "rb", "php", "swift",
  "kt", "lua", "pl", "r", "sql",
]);
register("data", Braces, "#14b8a6", "Structured data", [
  "json", "xml", "yaml", "yml", "toml", "ini", "conf", "plist",
]);
register("data", Database, "#14b8a6", "Database", [
  "db", "sqlite", "sqlite3", "mdb", "accdb", "dump", "bak",
]);
register("data", Settings2, "#64748b", "Configuration", ["cfg", "env", "properties"]);

// --- Fonts -------------------------------------------------------------
register("font", Type, "#d946ef", "Font", ["ttf", "otf", "woff", "woff2", "eot", "fon"]);

const FALLBACK: FileKind = {
  group: "other",
  icon: Binary,
  colour: "#94a3b8",
  label: "File",
};

/**
 * Looks up the kind for a filename.
 *
 * Handles the double extensions that matter (`.tar.gz`, `.tar.xz`) by checking
 * the compound first, so a tarball reads as an archive rather than as whatever
 * `.gz` alone maps to.
 */
export function fileKind(filename: string): FileKind {
  const lower = filename.toLowerCase();
  if (/\.tar\.(gz|bz2|xz|zst|lz)$/.test(lower)) return KINDS.tar ?? FALLBACK;

  const dot = lower.lastIndexOf(".");
  if (dot <= 0 || dot === lower.length - 1) return FALLBACK;
  return KINDS[lower.slice(dot + 1)] ?? FALLBACK;
}

/** The category folder name a file is sorted into, for display. */
export function groupLabel(group: FileKind["group"]): string {
  switch (group) {
    case "video":
      return "Video";
    case "audio":
      return "Music";
    case "image":
      return "Pictures";
    case "document":
      return "Documents";
    case "archive":
    case "disc":
      return "Compressed";
    case "program":
      return "Programs";
    default:
      return "Downloads";
  }
}

/**
 * The icon tile used in the list and in dialogs.
 *
 * `color-mix` against the surface keeps the tint readable in both themes
 * without maintaining a second palette: the same hex reads as a pale wash on
 * white and a deep one on near-black.
 */
export function FileTile({
  filename,
  size = 32,
  active = false,
}: {
  filename: string;
  size?: number;
  active?: boolean;
}) {
  const kind = fileKind(filename);
  const Icon = kind.icon;
  return (
    <div
      className="grid shrink-0 place-items-center rounded-[8px]"
      style={{
        width: size,
        height: size,
        background: `color-mix(in srgb, ${kind.colour} ${active ? 22 : 14}%, transparent)`,
        color: kind.colour,
      }}
      title={kind.label}
      aria-label={kind.label}
    >
      <Icon size={Math.round(size * 0.48)} strokeWidth={2} />
    </div>
  );
}
