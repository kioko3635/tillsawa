import { readFileSync } from 'node:fs';
import type { BusinessLibraryEntry } from './library-types.js';

export const businessLibraryData = JSON.parse(readFileSync(new URL('../../../data/business-library.json', import.meta.url), 'utf8')) as {
  version: string;
  sources: Array<{ source: string; key: string; sourceProducts: number }>;
  entries: BusinessLibraryEntry[];
};
