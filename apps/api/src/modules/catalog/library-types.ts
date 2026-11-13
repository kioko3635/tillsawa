import type { BusinessProfileCode } from '@pos/contracts';

export interface BusinessLibraryEntry {
  id: string;
  sku: string;
  family: string;
  name: string;
  size: string;
  category: string;
  brand: string | null;
  profiles: BusinessProfileCode[];
  itemType: 'stocked' | 'non_stock' | 'service';
  unitCode: string;
  sourceUrl: string | null;
  sourceImageUrl: string | null;
  imageUrl: string;
  photoKind: 'product_photo' | 'style_photo' | 'illustration';
  imageStatus: string;
  template?: boolean;
}
