import { BUSINESS_PROFILE_DEFINITIONS, type BusinessProfileCode } from '@pos/contracts';
import { businessLibraryData } from './business-library-data.js';
import { liquorLibraryData } from './liquor-library-data.js';
import { catalogueTemplates } from './catalogue-templates.js';
import type { BusinessLibraryEntry } from './library-types.js';

const liquorEntries: BusinessLibraryEntry[] = liquorLibraryData.entries.map((entry) => ({
  ...entry, family: entry.name.replace(/\b\d+(?:\.\d+)?\s*(?:ml|litres?|liters?|ltr?s?|cl)\b/gi, '').replace(/\s+/g, ' ').trim(), brand: null, profiles: ['wines_spirits', 'wholesale_distribution'],
  itemType: 'stocked', unitCode: 'EA', photoKind: 'product_photo'
}));
export const businessLibraryEntries: BusinessLibraryEntry[] = [
  ...liquorEntries, ...businessLibraryData.entries.map((entry) => ({ ...entry,
    family: entry.family === entry.name ? entry.family.replace(/\b\d+(?:\.\d+)?\s*(?:kg|mg|g|ml|litres?|liters?|ltr?s?|cl|gb|tb|mah|wh|kw|watts?|w|mm|cm|metres?|meters?|inches|inch|pcs?|pieces?|packs?)\b/gi, '').replace(/\s+/g, ' ').replace(/\s*[-–—]\s*$/, '').trim() || entry.family : entry.family
  })), ...catalogueTemplates
];
const index = new Map(businessLibraryEntries.map((entry) => [entry.id, entry]));
export function libraryForProfile(profile: BusinessProfileCode) {
  return businessLibraryEntries.filter((entry) => entry.profiles.includes(profile));
}
export function libraryEntryForProfile(id: string, profile: BusinessProfileCode) {
  const entry = index.get(id);
  return entry?.profiles.includes(profile) ? entry : undefined;
}
export function libraryProfileLabel(profile: BusinessProfileCode) {
  return BUSINESS_PROFILE_DEFINITIONS.find((definition) => definition.code === profile)?.label ?? profile;
}
export const businessLibraryVersion = [businessLibraryData.version, liquorLibraryData.version].sort().at(-1)!;
