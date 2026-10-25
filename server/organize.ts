import type { Memory } from '../src/types.js';
import {
  FALLBACK_FOLDER, HOLIDAY_FOLDERS, THEME_FOLDERS, friendlyMemoryTitle, isDateLikeLabel, sanitizeFolderLabel,
} from '../src/memory-labels.js';

const clean = (value: string) => value.trim().replace(/\s+/g, ' ').slice(0, 80);
type Category = NonNullable<Memory['organization']>['category'];
export type FolderSuggestion = { label: string; category: Category; reason: string; kind: 'holiday' | 'location' | 'theme' | 'fallback' };

type Holiday = typeof HOLIDAY_FOLDERS[number];
/**
 * Caption/tag signals, each valid only inside its season so "costume" in March
 * or "Santa Cruz" in July never becomes a holiday. [month, day] windows are
 * inclusive and may wrap the year end.
 */
const holidayText: { name: Holiday; pattern: RegExp; season: [[number, number], [number, number]] }[] = [
  { name: 'Halloween', pattern: /\bhalloween\b|\bcostumes?\b|\bpumpkins?\b|jack[- ]?o[- ]?lantern|trick[- ]?or[- ]?treat/, season: [[10, 1], [11, 7]] },
  { name: 'Thanksgiving', pattern: /\bthanksgiving\b|\bfriendsgiving\b/, season: [[11, 1], [11, 30]] },
  { name: 'Christmas', pattern: /\bchristmas\b|\bxmas\b|\bsanta claus\b|\bsecret santa\b|\bsanta\b(?! (monica|cruz|barbara|clara|rosa|ana|fe|maria|catalina|teresa|anita|paula|fe)\b)/, season: [[11, 20], [1, 6]] },
  { name: 'New Year', pattern: /\bnew year'?s?\b|\bnye\b/, season: [[12, 26], [1, 7]] },
  { name: "Valentine's Day", pattern: /\bvalentine'?s?\b|\bgalentine'?s?\b/, season: [[2, 1], [2, 20]] },
];

/** Fourth Thursday of November, the US Thanksgiving holiday. */
function isThanksgiving(date: string) {
  const match = /^(\d{4})-11-(\d{2})/.exec(date); if (!match) return false;
  const day = Number(match[2]);
  const weekday = new Date(Date.UTC(Number(match[1]), 10, day)).getUTCDay();
  return weekday === 4 && day >= 22 && day <= 28;
}

function previousDay(date: string) {
  const parsed = new Date(`${date.slice(0, 10)}T12:00:00Z`);
  parsed.setUTCDate(parsed.getUTCDate() - 1);
  return parsed.toISOString().slice(0, 10);
}

/** The holiday on one calendar day, with the year its folder is named for. */
function holidayOnDay(date: string): { name: Holiday; year: number } | undefined {
  if (!/^\d{4}-\d{2}-\d{2}/.test(date)) return undefined;
  const year = Number(date.slice(0, 4)); const monthDay = date.slice(5, 10);
  if (monthDay === '10-31') return { name: 'Halloween', year };
  if (monthDay === '12-24' || monthDay === '12-25') return { name: 'Christmas', year };
  // New Year's Eve and New Year's Day are one celebration, named for the year that begins.
  if (monthDay === '12-31') return { name: 'New Year', year: year + 1 };
  if (monthDay === '01-01') return { name: 'New Year', year };
  if (monthDay === '02-14') return { name: "Valentine's Day", year };
  if (isThanksgiving(date)) return { name: 'Thanksgiving', year };
  return undefined;
}

/** Holiday nights run past midnight: photos before 4 am still belong to the evening before. */
function holidayFromMoment(date: string, hour?: number) {
  const today = holidayOnDay(date);
  if (hour !== undefined && hour < 4) {
    const lastNight = holidayOnDay(previousDay(date));
    if (lastNight && !(today && today.name === 'New Year' && lastNight.name === 'New Year')) return lastNight;
  }
  return today;
}

const inSeason = (date: string, [[m1, d1], [m2, d2]]: [[number, number], [number, number]]) => {
  if (!/^\d{4}-\d{2}-\d{2}/.test(date)) return true; // no date: trust the caption
  const value = Number(date.slice(5, 7)) * 100 + Number(date.slice(8, 10));
  const start = m1 * 100 + d1; const end = m2 * 100 + d2;
  return start <= end ? value >= start && value <= end : value >= start || value <= end;
};

/**
 * Holiday for a memory. The calendar date wins (a pumpkin pie on Thanksgiving
 * is Thanksgiving); captions only count inside the holiday's season.
 */
export function holidayFor(memory: Pick<Memory, 'date' | 'capturedAt' | 'title' | 'description' | 'tags' | 'mediaType'>): { name: Holiday; year?: number } | undefined {
  const moment = effectiveMoment(memory);
  const byDate = holidayFromMoment(moment.date, moment.hour);
  if (byDate) return byDate;
  const text = memoryText(memory);
  const match = holidayText.find(entry => entry.pattern.test(text) && inSeason(moment.date, entry.season));
  if (!match) return undefined;
  return { name: match.name, ...seasonYear(match.name, moment.date) };
}

/** The year a holiday folder is named for when a date falls in that holiday's season. */
function seasonYear(name: Holiday, date: string): { year?: number } {
  if (!/^\d{4}/.test(date)) return {};
  const year = Number(date.slice(0, 4)); const month = date.slice(5, 7);
  if (name === 'New Year' && month === '12') return { year: year + 1 };
  if (name === 'Christmas' && month === '01') return { year: year - 1 };
  return { year };
}

/** Whether a memory's date could belong to a holiday (its season), and the folder year if so. */
export function holidayInSeason(name: Holiday, memory: Pick<Memory, 'date' | 'capturedAt'>) {
  const moment = effectiveMoment(memory);
  const entry = holidayText.find(value => value.name === name)!;
  return inSeason(moment.date, entry.season) ? seasonYear(name, moment.date) : undefined;
}

const themes: [RegExp, typeof THEME_FOLDERS[number]][] = [
  [/\b(travel|trip|vacation|airport|flight|hotel|road ?trip|passport|sightseeing)\b/, 'Travel'],
  [/\b(family|parents?|mom|dad|mother|father|siblings?|brother|sister|cousins?|grandma|grandpa|grandparents?)\b/, 'Family'],
  [/\b(friends?|crew|hangout|squad|roommates?)\b/, 'Friends'],
  [/\b(school|class|campus|lecture|homework|university|college|graduation|office|work|hackathon|calhacks|conference|meeting|internship)\b/, 'School and work'],
  [/\b(food|dinner|lunch|breakfast|brunch|restaurant|cooking|meal|coffee|cafe|bakery|dessert|cake)\b/, 'Food and places'],
  [/\b(beach|ocean|mountains?|hike|hiking|park|outdoors?|nature|sunset|sunrise|lake|forest|camping|trail|garden|snow)\b/, 'Outdoors'],
  [/\b(sports?|soccer|basketball|football|tennis|gym|workout|running|marathon|baseball|volleyball|swim|swimming|climbing|ski|skiing)\b/, 'Sports'],
  [/\b(nightlife|bar|club|clubbing|late night|night out|dancing)\b/, 'Nights out'],
  [/\b(party|concert|festival|event|birthday|wedding|ceremony|show|celebration|parade)\b/, 'Events'],
  [/\b(dogs?|cats?|pets?|puppy|kitten|hamster|bunny)\b/, 'Pets'],
  [/\b(person|people|portrait|selfie|faces?|crowd|group photo)\b/, 'People'],
];

function memoryText(memory: Pick<Memory, 'title' | 'description' | 'tags' | 'mediaType'>) {
  const title = friendlyMemoryTitle(memory);
  const description = memory.description.replace(/^(selected from google photos\.|imported social post\.|sample memory:)\s*/i, '');
  return `${title === 'Photo memory' || title === 'Video memory' ? '' : title} ${description} ${memory.tags.join(' ')}`.toLowerCase();
}

export function explicitLocation(memory: Pick<Memory, 'location'>) {
  const location = sanitizeFolderLabel(memory.location || '', '');
  return location && !isDateLikeLabel(location) ? location : '';
}

/**
 * Providers such as Google Photos report capture times in UTC. Holidays are
 * local events (a photo at 7 pm on Oct 31 in California is 02:00 UTC on Nov 1),
 * so calendar decisions use the person's time zone: the browser's zone sent with
 * an import, else MEMOIR_TIME_ZONE, else the server's own zone.
 */
let organizerTimeZone = validTimeZone(process.env.MEMOIR_TIME_ZONE) || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
export function validTimeZone(value: unknown) {
  if (typeof value !== 'string' || !value || value.length > 64) return undefined;
  try { new Intl.DateTimeFormat('en-US', { timeZone: value }); return value; } catch { return undefined; }
}
export function setOrganizerTimeZone(value: string) { organizerTimeZone = validTimeZone(value) || organizerTimeZone; return organizerTimeZone; }
export function getOrganizerTimeZone() { return organizerTimeZone; }

/** Local calendar date and hour of a timestamp in a time zone. */
export function localDateTime(timestamp: string, timeZone = organizerTimeZone) {
  const parsed = Date.parse(timestamp);
  if (!Number.isFinite(parsed)) return undefined;
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' }).formatToParts(parsed).map(part => [part.type, part.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour) };
}

/** The memory's local date/hour: an absolute capture timestamp wins over the stored date field. */
export function effectiveMoment(memory: Pick<Memory, 'date' | 'capturedAt'>, timeZone = organizerTimeZone) {
  if (memory.capturedAt && /T\d{2}:\d{2}/.test(memory.capturedAt) && /(Z|[+-]\d{2}:?\d{2})$/i.test(memory.capturedAt)) {
    const local = localDateTime(memory.capturedAt, timeZone);
    if (local) return local;
  }
  return { date: /^\d{4}-\d{2}-\d{2}/.test(memory.date) ? memory.date.slice(0, 10) : '', hour: undefined as number | undefined };
}

const year = (memory: Pick<Memory, 'date' | 'capturedAt'>) => { const date = effectiveMoment(memory).date; return /^\d{4}-\d{2}/.test(date) ? date.slice(0, 4) : ''; };

/**
 * Deterministic first-pass folder. Priority: holiday (with year) → explicit
 * location metadata → broad theme → "Everyday moments". It never guesses
 * identities, relationships, unstated locations, or sensitive traits, and it
 * never names a folder by a bare date.
 */
export function suggestFolder(memory: Memory): FolderSuggestion {
  const text = memoryText(memory);
  const holiday = holidayFor(memory);
  if (holiday) return { label: holiday.year ? `${holiday.name} ${holiday.year}` : holiday.name, category: 'holiday', reason: 'calendar moment or holiday signal', kind: 'holiday' };
  const location = explicitLocation(memory);
  if (location) return { label: location, category: 'trip', reason: 'explicit location metadata', kind: 'location' };
  const theme = themes.find(([pattern]) => pattern.test(text))?.[1];
  if (theme) return { label: theme, category: theme === 'Travel' ? 'trip' : 'event', reason: 'broad theme signal', kind: 'theme' };
  return { label: FALLBACK_FOLDER, category: 'daily', reason: 'safe general category', kind: 'fallback' };
}

/**
 * Whether a folder label is supported by this memory's own metadata. Used to
 * validate Gemini renames and stale stored labels: only exact taxonomy themes,
 * a holiday whose year matches the memory date, or a place that literally
 * appears in the memory's location field are accepted.
 */
export function isAllowedFolderLabel(label: string, memory: Memory) {
  if (!label || isDateLikeLabel(label) || label !== sanitizeFolderLabel(label, '')) return false;
  if ((THEME_FOLDERS as readonly string[]).includes(label)) return true;
  const holiday = HOLIDAY_FOLDERS.find(name => label === name || label.startsWith(`${name} `));
  if (holiday) {
    // A holiday is allowed only inside its season (or the memory's own holiday), with that season's year.
    const actual = holidayFor(memory);
    if (actual && actual.name !== holiday) return false; // a dated holiday is never relabeled as another one
    const expected = actual?.name === holiday ? actual : holidayInSeason(holiday, memory);
    if (!expected) return false;
    const suffix = label.slice(holiday.length).trim();
    return suffix === '' ? !expected.year : suffix === String(expected.year);
  }
  const location = explicitLocation(memory);
  if (!location) return false;
  const parts = [location, ...location.split(',').map(part => part.trim())].filter(Boolean).map(part => part.toLowerCase());
  return parts.includes(label.toLowerCase());
}

/** Explainable organization; a stored label survives only if it still validates. */
export function organizeMemory(memory: Memory): Memory {
  const localDate = effectiveMoment(memory).date;
  const date = /^\d{4}-\d{2}/.test(localDate) ? localDate.slice(0, 7) : 'undated';
  const location = explicitLocation(memory);
  const title = friendlyMemoryTitle({ title: clean(memory.title), mediaType: memory.mediaType });
  const tags = [...new Set(memory.tags.map(tag => clean(tag.toLowerCase())).filter(Boolean))].slice(0, 30);
  const normalized: Memory = { ...memory, title, tags };
  const stored = memory.organization;
  const storedLabel = stored?.folderPath?.at(-1) || stored?.label || '';
  const suggestion = suggestFolder(normalized);
  // Only a Gemini-reviewed label is kept over a fresh local derivation (local
  // labels are just a cache of these rules), and a holiday always wins.
  const holidayWins = suggestion.kind === 'holiday' && storedLabel !== suggestion.label;
  if (stored && stored.organizedBy === 'gemini' && !holidayWins && isAllowedFolderLabel(storedLabel, normalized)) {
    return { ...normalized, importedAt: memory.importedAt || new Date().toISOString(), organization: { ...stored, label: storedLabel, folderPath: [storedLabel] } };
  }
  const reasons: string[] = [`source:${memory.source}`];
  if (date !== 'undated') reasons.push(`month:${date}`);
  if (location) reasons.push('location');
  if (tags.length) reasons.push('tags');
  const confidence = suggestion.kind === 'fallback' ? 'low' : suggestion.kind === 'theme' ? 'medium' : 'high';
  return {
    ...normalized,
    importedAt: memory.importedAt || new Date().toISOString(),
    organization: {
      key: [date, location.toLowerCase() || 'none'].join('|'), label: suggestion.label, confidence,
      reasons: [...reasons, suggestion.reason], folderPath: [suggestion.label], category: suggestion.category, organizedBy: 'local',
    },
  };
}
