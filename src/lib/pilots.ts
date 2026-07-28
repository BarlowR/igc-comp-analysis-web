// Pilot identity helpers.
//
// A pilot's name in the archive comes from the IGC pilot header when it has one
// and from the filename otherwise, so the same person shows up as "casey
// gerstle", "David Suder", "(Bruno) Subarno.1177.131" or "Walter H Gutiérrez ".
// slugifyPilot folds that into one stable join key; the original string is kept
// alongside it for display.

/** Trailing xcdemon id segments, e.g. "(Bruno) Subarno.1177.131" -> ".1177.131". */
const TRAILING_IDS = /(?:\.\d+)+$/;

/** Combining marks left behind by NFD normalisation. */
const COMBINING_MARKS = /[\u0300-\u036f]/g;

/**
 * Normalise a displayed pilot name into a join key: lower case, diacritics
 * folded, xcdemon id suffix dropped, anything non-alphanumeric collapsed to a
 * single hyphen. Returns '' for names we can't key on (blank, digits only),
 * which callers should treat as unclaimable.
 */
export function slugifyPilot(name: string): string {
  return name
    .normalize('NFD')
    .replace(COMBINING_MARKS, '')
    .replace(TRAILING_IDS, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Tidy a displayed pilot name without changing who it refers to. */
export function cleanPilotLabel(name: string): string {
  return name.replace(TRAILING_IDS, '').replace(/\s+/g, ' ').trim();
}
