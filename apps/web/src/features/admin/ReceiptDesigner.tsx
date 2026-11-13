import { DEFAULT_RECEIPT_DESIGN, type ReceiptDesign } from '@pos/contracts';
import { Button, CheckboxField, SelectField } from '../../design-system/components';
import { ReceiptPaper, type ReceiptPresentation } from '../pos/ReceiptPaper';

export function ReceiptDesigner({ design, onChange, receipt, disabled }: { design: ReceiptDesign; onChange: (design: ReceiptDesign) => void; receipt: ReceiptPresentation; disabled: boolean }) {
  function update<K extends keyof ReceiptDesign>(key: K, value: ReceiptDesign[K]) { onChange({ ...design, [key]: value }); }
  const toggles = { showLogo: 'Company logo', showLegalName: 'Legal business name', showAddress: 'Business address', showContact: 'Phone and email', showTaxPin: 'Tax registration reference', showLoyalty: 'Loyalty points' } as const;
  return <div className="receipt-designer">
    <div className="receipt-design-controls">
      <h3>Make it yours</h3><p>Choose a starting style, then adjust the details. Your preview updates as you work.</p>
      <div className="receipt-presets" role="group" aria-label="Receipt styles">{(['classic', 'modern', 'compact'] as const).map(layout => <Button key={layout} type="button" variant={design.layout === layout ? 'primary' : 'secondary'} disabled={disabled} aria-pressed={design.layout === layout} onClick={() => onChange({ ...design, layout, font: layout === 'modern' ? 'sans' : 'mono', alignment: layout === 'compact' ? 'left' : 'center' })}>{layout.charAt(0).toUpperCase() + layout.slice(1)}</Button>)}</div>
      <div className="form-grid">
        <SelectField label="Receipt paper" value={design.paper} disabled={disabled} onChange={e => update('paper', e.target.value as ReceiptDesign['paper'])}><option value="58mm">58 mm thermal roll</option><option value="80mm">80 mm thermal roll</option><option value="a4">A4 document</option></SelectField>
        <SelectField label="Typeface" value={design.font} disabled={disabled} onChange={e => update('font', e.target.value as ReceiptDesign['font'])}><option value="mono">Receipt / monospace</option><option value="sans">Clean / sans serif</option></SelectField>
        <SelectField label="Text size" value={design.fontSize} disabled={disabled} onChange={e => update('fontSize', e.target.value as ReceiptDesign['fontSize'])}><option value="small">Small</option><option value="regular">Regular</option><option value="large">Large</option></SelectField>
        <SelectField label="Heading alignment" value={design.alignment} disabled={disabled} onChange={e => update('alignment', e.target.value as ReceiptDesign['alignment'])}><option value="center">Centre</option><option value="left">Left</option></SelectField>
        <SelectField label="Logo size" value={design.logoSize} disabled={disabled} onChange={e => update('logoSize', e.target.value as ReceiptDesign['logoSize'])}><option value="small">Small</option><option value="medium">Medium</option><option value="large">Large</option></SelectField>
      </div>
      <h4>Details to include</h4><div className="receipt-detail-toggles">{Object.entries(toggles).map(([key, label]) => <CheckboxField key={key} label={label} checked={design[key as keyof typeof toggles]} disabled={disabled} onChange={checked => update(key as keyof typeof toggles, checked)} />)}</div>
      <p className="field-hint">Receipt number, date, cashier, items, totals, payment verification and fiscal notices always remain visible. Design changes also apply when reprinting older sales.</p>
      <Button type="button" variant="secondary" disabled={disabled} onClick={() => onChange({ ...DEFAULT_RECEIPT_DESIGN })}>Reset design</Button>
    </div>
    <div className="receipt-live-preview"><div className="receipt-preview-toolbar"><strong>Live preview</strong><span>{design.paper === 'a4' ? 'A4' : design.paper} · sample data</span></div><div className="receipt-preview-scroll"><ReceiptPaper receipt={receipt} sample /></div><p>Save configuration to apply. Match paper size and 100% scale in your printer settings.</p></div>
  </div>;
}
