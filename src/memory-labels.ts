import type { Memory } from "./types";

/** Root, archive, and category names. Tests assert these exact strings. */
export const PICTURES_FOLDER = "Pictures";
export const ALL_MEMORIES_FOLDER = "All memories";
export const HOLIDAY_FOLDERS = ["Halloween", "Thanksgiving", "Christmas", "New Year", "Valentine's Day"] as const;
export const THEME_FOLDERS = [
  "Travel",
  "Family",
  "Friends",
  "School and work",
  "Food and places",
  "Outdoors",
  "Events",
  "People",
  "Sports",
  "Nights out",
  "Pets",
  "Everyday moments",
] as const;
export const FALLBACK_FOLDER = "Everyday moments";

const mediaExtension = /\.(jpe?g|png|webp|gif|heic|heif|avif|tiff?|bmp|mp4|webm|mov|m4v|avi|3gp)$/i;
const cameraPrefix = /^(pxl|img|dsc|dscn|dscf|dji|gopr|gp|vid|mvimg|mv|mov|p|photo|image|pic|screenshot|screen[ _-]?shot|screen[ _-]?recording|signal|whatsapp[ _-]?(image|video)|snapchat|fb_img|received|pano|burst|imag)[-_ ]?[a-z]?\d/i;

/** True for camera/export filenames that should never be shown as a memory title. */
export function isFilenameLike(value: string) {
  const title = value.trim();
  if (!title) return true;
  if (mediaExtension.test(title)) return true;
  if (cameraPrefix.test(title)) return true;
  // 20251031_183012, 2025-10-31 18.30.12, IMG-20251031-WA0001 style, UUIDs and long hex/hash names.
  if (/^\d{6,}[\d_\-. ]*$/.test(title)) return true;
  if (/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(title)) return true;
  if (/^[\da-f]{16,}$/i.test(title)) return true;
  if (/^[a-z0-9]{2,6}[_-]\d{4,}([_-]\d+)*$/i.test(title)) return true;
  return false;
}

export function friendlyMemoryTitle(memory: Pick<Memory, "title" | "mediaType">) {
  return isFilenameLike(memory.title) ? (memory.mediaType === "video" ? "Video memory" : "Photo memory") : memory.title.trim();
}

const months = "january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec";
/** Folders are never named by a bare date, month, or year ("October 2025", "2025-10", "2025"). */
export function isDateLikeLabel(value: string) {
  const label = value.trim().toLowerCase();
  if (!label) return true;
  if (/^[\d\s\-/.:_,]+$/.test(label)) return true;
  if (new RegExp(`^(${months})\\.?(\\s+\\d{1,2}(st|nd|rd|th)?)?,?(\\s+\\d{4})?$`).test(label)) return true;
  if (new RegExp(`^(\\d{1,2}\\s+)?(${months})\\.?\\s*,?\\s*\\d{4}$`).test(label)) return true;
  if (/^(spring|summer|fall|autumn|winter|undated|unsorted|unknown|untitled|misc|miscellaneous|photos?|images?|videos?|media|uploads?|imports?|new folder|folder)(\s+\d{4})?$/.test(label)) return true;
  if (/^(week|day|month|year)\b/.test(label)) return true;
  return false;
}

/** Strip control/path characters and collapse whitespace. Never returns an empty label. */
export function sanitizeFolderLabel(value: string, fallback = FALLBACK_FOLDER) {
  const clean = String(value ?? "")
    .normalize("NFKC")
    .replace(/[\\/:*?"<>|#{}[\]`$^~\u0000-\u001f\u007f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60)
    .trim();
  return clean || fallback;
}
