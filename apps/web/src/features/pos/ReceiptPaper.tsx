import type { CSSProperties } from 'react';
import { receiptDesign, unitLabel } from '@pos/contracts';
import type { Receipt } from '../../lib/api/types';

export type ReceiptPresentation = Omit<Receipt, 'sale'> & { sale: Pick<Receipt['sale'], 'receiptNumber' | 'soldAt' | 'cashierName' | 'currency' | 'subtotal' | 'discountTotal' | 'taxTotal' | 'total' | 'creditDueDate'> & { lines: Pick<Receipt['sale']['lines'][number], 'id' | 'productName' | 'quantity' | 'unitCode' | 'unitPrice' | 'total'>[]; payments: Receipt['sale']['payments'] } };

/** The designer and checkout deliberately render the very same receipt. */
export function ReceiptPaper({ receipt, sample = false }: { receipt: ReceiptPresentation; sample?: boolean }) {
  const shop = receipt.organization;
  const sale = receipt.sale;
  const design = receiptDesign(shop.receiptDesign);
  const payment = sale.payments[0];
  const width = design.paper === 'a4' ? '190mm' : design.paper === '58mm' ? '48mm' : '72mm';
  const style = { '--receipt-width': width, '--receipt-font-size': `${design.fontSize === 'small' ? 10 : design.fontSize === 'large' ? 14 : 12}px`, '--receipt-align': design.alignment, '--receipt-logo-width': `${design.logoSize === 'small' ? 70 : design.logoSize === 'large' ? 180 : 120}px` } as CSSProperties;
  return <article className={`receipt-paper receipt-designed receipt-${design.layout} receipt-font-${design.font}`} style={style} data-paper={design.paper}>
    {sample ? <p className="receipt-sample">SAMPLE · NOT A SALE</p> : null}
    <header className="receipt-heading">
      {design.showLogo && shop.receiptLogoUrl ? <img className="receipt-logo" src={shop.receiptLogoUrl} alt={`${shop.displayName} logo`} /> : null}
      <h2>{shop.displayName}</h2>
      {design.showLegalName && shop.legalName !== shop.displayName ? <p>{shop.legalName}</p> : null}
      {shop.receiptHeader ? <p>{shop.receiptHeader}</p> : null}
      {design.showAddress && shop.businessAddress ? <p>{shop.businessAddress}</p> : null}
      {design.showContact && (shop.contactPhone || shop.contactEmail) ? <p>{[shop.contactPhone, shop.contactEmail].filter(Boolean).join(' · ')}</p> : null}
      {design.showTaxPin && shop.taxPin ? <p>KRA PIN: {shop.taxPin}</p> : null}
    </header>
    <div className="receipt-sale-meta"><p>{shop.branchName} · {shop.registerName}</p><p><strong>Receipt {sale.receiptNumber}</strong><br />{new Intl.DateTimeFormat('en-KE', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Africa/Nairobi' }).format(new Date(sale.soldAt))}<br />Served by: {sale.cashierName}</p></div>
    <table><thead><tr><th>Item / quantity</th><th>Amount</th></tr></thead><tbody>{sale.lines.map(line => <tr key={line.id}><td>{line.productName}<br /><small>{Number(line.quantity).toLocaleString('en-KE', { maximumFractionDigits: 6 })} {unitLabel(line.unitCode)} × {line.unitPrice}</small></td><td>{line.total}</td></tr>)}</tbody></table>
    <dl>
      <div><dt>Subtotal</dt><dd>{sale.subtotal}</dd></div>
      <div><dt>Discount</dt><dd>{sale.discountTotal}</dd></div>
      <div><dt>Tax</dt><dd>{sale.taxTotal}</dd></div>
      <div className="receipt-total"><dt>Total</dt><dd>{sale.currency} {sale.total}</dd></div>
      {receipt.loyalty && Number(receipt.loyalty.redeemedValue) > 0 ? <div><dt>Paid with points</dt><dd>{sale.currency} {receipt.loyalty.redeemedValue}</dd></div> : null}
      <div><dt>Payment</dt><dd>{payment?.method.toUpperCase()} · {payment?.status}</dd></div>
      {payment?.reference ? <><div><dt>Reference</dt><dd>{payment.reference}</dd></div><div><dt>Verification</dt><dd>{payment.verification === 'manual' ? 'Manually checked by cashier' : payment.verification === 'pesapal_verified' ? 'Verified by Pesapal' : 'TEST PAYMENT — no money moved'}</dd></div></> : null}
      {payment?.method === 'cash' ? <><div><dt>Cash tendered</dt><dd>{payment.amountTendered}</dd></div><div><dt>Change</dt><dd>{payment.change}</dd></div></> : payment?.method === 'credit' ? <div><dt>Credit due</dt><dd>{sale.creditDueDate ?? '—'}</dd></div> : null}
    </dl>
    {design.showLoyalty && receipt.loyalty ? <div className="receipt-loyalty"><strong>Loyalty points</strong><p>Earned: {receipt.loyalty.earned}<br />Redeemed: {receipt.loyalty.redeemed} · {sale.currency} {receipt.loyalty.redeemedValue}<br />Balance after purchase: {receipt.loyalty.balanceAfter}</p>{receipt.loyalty.reversedEarned !== '0' || receipt.loyalty.restoredRedeemed !== '0' ? <p>Earned points reversed: {receipt.loyalty.reversedEarned}<br />Redeemed points restored: {receipt.loyalty.restoredRedeemed}</p> : null}</div> : null}
    <footer className="receipt-footer"><p>{shop.receiptFooter}</p><p>{shop.receiptPolicy}</p><p className="receipt-notice">{receipt.complianceNotice}</p></footer>
  </article>;
}
