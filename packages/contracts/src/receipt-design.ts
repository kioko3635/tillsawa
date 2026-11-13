import { z } from 'zod';

/** Shared by the designer, API and receipt printer. Transaction facts stay mandatory. */
export const receiptDesignSchema = z.object({
  paper: z.enum(['58mm', '80mm', 'a4']).default('80mm'),
  layout: z.enum(['classic', 'modern', 'compact']).default('classic'),
  font: z.enum(['mono', 'sans']).default('mono'),
  fontSize: z.enum(['small', 'regular', 'large']).default('regular'),
  alignment: z.enum(['center', 'left']).default('center'),
  logoSize: z.enum(['small', 'medium', 'large']).default('medium'),
  showLogo: z.boolean().default(true),
  showLegalName: z.boolean().default(true),
  showAddress: z.boolean().default(true),
  showContact: z.boolean().default(true),
  showTaxPin: z.boolean().default(true),
  showLoyalty: z.boolean().default(true)
}).strict();

export type ReceiptDesign = z.infer<typeof receiptDesignSchema>;
export const DEFAULT_RECEIPT_DESIGN: ReceiptDesign = receiptDesignSchema.parse({});
export function receiptDesign(value: unknown): ReceiptDesign {
  const parsed = receiptDesignSchema.safeParse(value);
  return parsed.success ? parsed.data : { ...DEFAULT_RECEIPT_DESIGN };
}
