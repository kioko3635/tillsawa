const UNIT_NAMES: Readonly<Record<string, string>> = {
  EA: 'Each', KG: 'Kilogram', G: 'Gram', L: 'Litre', ML: 'Millilitre',
  PACK: 'Pack', CASE: 'Case', BOX: 'Box', PAIR: 'Pair', DOZ: 'Dozen',
  STK: 'Stick', PCS: 'Pieces'
};

/** Human-readable labels only; stored codes and conversion identifiers stay stable. */
export function unitLabel(code: string | null | undefined, name?: string | null): string {
  const value = code?.trim() ?? '';
  const fullName = name?.trim();
  if (fullName && fullName.toUpperCase() !== value.toUpperCase()) return fullName;
  return UNIT_NAMES[value.toUpperCase()] ?? (fullName || value || '—');
}
