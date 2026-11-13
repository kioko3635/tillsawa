import { Badge, Card } from '../../design-system/components';
export function EtimsReadinessCard({ taxPin }: { taxPin: string | null | undefined }) {
  return <Card title="KRA eTIMS preparation" subtitle="Preparation only. Live tax invoice submission is not activated.">
    <Badge tone="warning">KRA onboarding required</Badge>
    <p>Business KRA PIN: <strong>{taxPin || 'Add your tax registration reference in receipt settings above'}</strong></p>
    <p>Your current POS receipts are sales receipts. They do not contain an invented KRA signature, QR code or fiscal invoice number.</p>
    <ol><li>Register your software business for KRA system-to-system integration and request sandbox access.</li><li>Discuss VSCU with KRA for shops that are not always online. OSCU is intended for systems that are always online.</li><li>Obtain the approved specifications and map each shop, branch, device, product classification, tax category and unit of measure.</li><li>Test invoices, rejected requests, retries, credit notes, returns and connectivity failures in the sandbox.</li><li>Complete KRA testing and approval before enabling live tax invoice submission for a client.</li></ol>
    <p><a href="https://www.kra.go.ke/business/etims-electronic-tax-invoice-management-system/learn-about-etims/etims-system-to-system-integration" target="_blank" rel="noreferrer">Open KRA integration requirements and sandbox guidance</a></p>
  </Card>;
}
