import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { Alert, Badge, Button, Card, EmptyState, PageHeader, SelectField, Spinner, TextField } from '../../design-system/components';
import { useAuth } from '../../app/useAuth';
import { api, ApiError } from '../../lib/api/client';
import type { CreditAccount, CreditTransaction, Customer, OutstandingSale, RegisterSession } from '../../lib/api/types';

function shortDate(value?: string | null) {
  return value ? new Date(value).toLocaleString('en-KE', { dateStyle: 'medium', timeStyle: 'short' }) : '—';
}

function tone(status: string): 'success' | 'warning' | 'danger' | 'info' {
  if (status === 'active' || status === 'paid' || status === 'completed') return 'success';
  if (status === 'hold' || status === 'partially_paid') return 'warning';
  if (status === 'disabled' || status === 'voided' || status === 'inactive') return 'danger';
  return 'info';
}

function decimalToMinor(value: string): bigint {
  const match = /^\s*(\d+)(?:\.(\d{1,2}))?\s*$/.exec(value);
  if (!match) return 0n;
  return BigInt(match[1]!) * 100n + BigInt((match[2] ?? '').padEnd(2, '0'));
}

function minorToDecimal(value: bigint): string {
  return `${value / 100n}.${String(value % 100n).padStart(2, '0')}`;
}

export function CreditPage() {
  const { bootstrap, hasPermission } = useAuth();
  const canManage = hasPermission('credit.manage');
  const canCollect = hasPermission('credit.collect');
  const canAdjust = hasPermission('credit.adjust');
  const canWriteOff = hasPermission('credit.write-off');
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [sessions, setSessions] = useState<RegisterSession[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [account, setAccount] = useState<CreditAccount | null>(null);
  const [transactions, setTransactions] = useState<CreditTransaction[]>([]);
  const [outstanding, setOutstanding] = useState<OutstandingSale[]>([]);
  const [search, setSearch] = useState('');
  const [creditFilter, setCreditFilter] = useState('');
  const [createForm, setCreateForm] = useState({ code: '', name: '', contactPerson: '', phone: '', email: '', address: '', taxPin: '', notes: '' });
  const [creditForm, setCreditForm] = useState({ creditStatus: 'disabled' as 'disabled' | 'active' | 'hold', creditLimit: '', paymentTermsDays: '0', reason: '' });
  const [paymentForm, setPaymentForm] = useState({ registerSessionId: '', amount: '', reason: '' });
  const [allocations, setAllocations] = useState<Record<string, string>>({});
  const [adjustmentForm, setAdjustmentForm] = useState({ type: 'credit_adjustment' as 'debit_adjustment' | 'credit_adjustment' | 'write_off', branchId: '', amount: '', saleId: '', reason: '' });
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  const openSessions = useMemo(() => sessions.filter((session) => session.status === 'open'), [sessions]);
  const allocatedTotal = useMemo(() => minorToDecimal(Object.values(allocations).reduce((sum, amount) => sum + decimalToMinor(amount), 0n)), [allocations]);

  const loadCustomers = useCallback(async () => {
    setError('');
    try {
      const [customerResult, sessionResult] = await Promise.all([
        api.customers({ search: search || undefined, creditStatus: creditFilter || undefined }),
        api.registerSessions({ pageSize: 50 })
      ]);
      setCustomers(customerResult.customers);
      setSessions(sessionResult.sessions);
      setSelectedId((current) => current || customerResult.customers[0]?.id || '');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Unable to load customers.');
    }
  }, [creditFilter, search]);

  const loadAccount = useCallback(async (customerId: string) => {
    if (!customerId) {
      setAccount(null);
      setTransactions([]);
      setOutstanding([]);
      return;
    }
    setError('');
    try {
      const result = await api.creditAccount(customerId);
      setAccount(result.account);
      setTransactions(result.transactions);
      setOutstanding(result.outstandingSales);
      setCreditForm({
        creditStatus: result.account.creditStatus,
        creditLimit: result.account.creditLimit,
        paymentTermsDays: String(result.account.paymentTermsDays),
        reason: ''
      });
      setAllocations(Object.fromEntries(result.outstandingSales.map((sale) => [sale.saleId, ''])));
      setAdjustmentForm((form) => ({ ...form, branchId: result.outstandingSales[0]?.branchId ?? bootstrap?.branches[0]?.id ?? '', saleId: result.outstandingSales[0]?.saleId ?? '' }));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Unable to load the customer credit account.');
    }
  }, [bootstrap?.branches]);

  useEffect(() => {
    setLoading(true);
    void loadCustomers().finally(() => setLoading(false));
  }, [loadCustomers]);

  useEffect(() => {
    void loadAccount(selectedId);
  }, [loadAccount, selectedId]);

  useEffect(() => {
    setPaymentForm((form) => form.registerSessionId ? form : { ...form, registerSessionId: openSessions[0]?.id ?? '' });
  }, [openSessions]);

  async function createCustomer(event: FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setError('');
    try {
      const result = await api.createCustomer({
        code: createForm.code,
        name: createForm.name,
        contactPerson: createForm.contactPerson || null,
        phone: createForm.phone || null,
        email: createForm.email || null,
        address: createForm.address || null,
        taxPin: createForm.taxPin || null,
        notes: createForm.notes || null,
        status: 'active'
      });
      setCreateForm({ code: '', name: '', contactPerson: '', phone: '', email: '', address: '', taxPin: '', notes: '' });
      setSelectedId(result.customer.id);
      setMessage(`Customer ${result.customer.name} created.`);
      await loadCustomers();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Unable to create customer.');
    } finally {
      setSubmitting(false);
    }
  }

  async function saveCredit(event: FormEvent) {
    event.preventDefault();
    if (!selectedId) return;
    setSubmitting(true);
    setError('');
    try {
      const result = await api.updateCreditAccount(selectedId, {
        creditStatus: creditForm.creditStatus,
        creditLimit: creditForm.creditLimit,
        paymentTermsDays: Number(creditForm.paymentTermsDays),
        reason: creditForm.reason
      });
      setAccount(result.account);
      setCreditForm((form) => ({ ...form, reason: '' }));
      setMessage('Credit account updated and audited.');
      await Promise.all([loadCustomers(), loadAccount(selectedId)]);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Unable to update credit settings.');
    } finally {
      setSubmitting(false);
    }
  }

  async function recordPayment(event: FormEvent) {
    event.preventDefault();
    if (!selectedId) return;
    const lines = Object.entries(allocations)
      .map(([saleId, amount]) => ({ saleId, amount }))
      .filter((line) => Number(line.amount) > 0);
    setSubmitting(true);
    setError('');
    try {
      const result = await api.recordCustomerPayment(selectedId, {
        clientTransactionId: crypto.randomUUID(),
        registerSessionId: paymentForm.registerSessionId,
        amount: paymentForm.amount,
        allocations: lines,
        reason: paymentForm.reason
      });
      setPaymentForm((form) => ({ ...form, amount: '', reason: '' }));
      setMessage(`Customer payment ${result.payment.paymentNumber} recorded.`);
      await Promise.all([loadCustomers(), loadAccount(selectedId)]);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Unable to record customer payment.');
    } finally {
      setSubmitting(false);
    }
  }

  async function postAdjustment(event: FormEvent) {
    event.preventDefault();
    if (!selectedId) return;
    setSubmitting(true);
    setError('');
    try {
      const result = await api.createCreditAdjustment(selectedId, {
        clientTransactionId: crypto.randomUUID(),
        type: adjustmentForm.type,
        branchId: adjustmentForm.branchId || undefined,
        amount: adjustmentForm.amount,
        reason: adjustmentForm.reason,
        allocations: adjustmentForm.type === 'debit_adjustment' ? undefined : [{ saleId: adjustmentForm.saleId, amount: adjustmentForm.amount }]
      });
      setAdjustmentForm((form) => ({ ...form, amount: '', reason: '' }));
      setMessage(result.replayed ? 'Adjustment replayed from the original transaction.' : 'Credit adjustment posted.');
      await Promise.all([loadCustomers(), loadAccount(selectedId)]);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Unable to post the credit adjustment.');
    } finally {
      setSubmitting(false);
    }
  }

  if (loading) return <Spinner label="Loading customer credit" />;

  return (
    <div className="page-stack">
      <PageHeader title="Customer credit" description="Credit limits, receivable balances, payment allocation, adjustments and account statements." />
      {message ? <Alert tone="success">{message}</Alert> : null}
      {error ? <Alert tone="danger">{error}</Alert> : null}

      <Card title="Customers" subtitle="Search the tenant-scoped register and select an account.">
        <form className="inline-form" onSubmit={(event) => { event.preventDefault(); void loadCustomers(); }}>
          <TextField label="Search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Name, code, phone or email" />
          <SelectField label="Credit status" value={creditFilter} onChange={(event) => setCreditFilter(event.target.value)}>
            <option value="">All accounts</option>
            <option value="disabled">Disabled</option>
            <option value="active">Active</option>
            <option value="hold">On hold</option>
          </SelectField>
          <Button type="submit" variant="secondary">Apply</Button>
        </form>
        {customers.length ? (
          <div className="list-stack">
            {customers.map((customer) => (
              <button className={`role-row ${selectedId === customer.id ? 'role-row-selected' : ''}`} key={customer.id} onClick={() => setSelectedId(customer.id)}>
                <span><strong>{customer.name}</strong><small>{customer.code} · {customer.phone ?? customer.email ?? 'No contact'} · outstanding {customer.outstandingBalance}</small></span>
                <Badge tone={tone(customer.creditStatus)}>{customer.creditStatus}</Badge>
              </button>
            ))}
          </div>
        ) : <EmptyState title="No customers" description="Create a customer profile below." />}
      </Card>

      <div className="dashboard-grid dashboard-grid-wide">
        <Card title="Create customer" subtitle="Credit is disabled until an authorized user configures it.">
          <form className="form-stack" onSubmit={(event) => void createCustomer(event)}>
            <div className="form-grid">
              <TextField label="Code" value={createForm.code} onChange={(event) => setCreateForm({ ...createForm, code: event.target.value.toUpperCase() })} required />
              <TextField label="Name" value={createForm.name} onChange={(event) => setCreateForm({ ...createForm, name: event.target.value })} required />
              <TextField label="Contact person" value={createForm.contactPerson} onChange={(event) => setCreateForm({ ...createForm, contactPerson: event.target.value })} />
              <TextField label="Phone" value={createForm.phone} onChange={(event) => setCreateForm({ ...createForm, phone: event.target.value })} />
              <TextField label="Email" type="email" value={createForm.email} onChange={(event) => setCreateForm({ ...createForm, email: event.target.value })} />
              <TextField label="KRA PIN" value={createForm.taxPin} onChange={(event) => setCreateForm({ ...createForm, taxPin: event.target.value.toUpperCase() })} />
            </div>
            <TextField label="Address" value={createForm.address} onChange={(event) => setCreateForm({ ...createForm, address: event.target.value })} />
            <TextField label="Notes" value={createForm.notes} onChange={(event) => setCreateForm({ ...createForm, notes: event.target.value })} />
            <Button type="submit" loading={submitting}>Create customer</Button>
          </form>
        </Card>

        <Card title="Credit account" subtitle={account ? `${account.code} · terms ${account.paymentTermsDays} days` : 'Select a customer'} actions={account ? <Badge tone={tone(account.creditStatus)}>{account.creditStatus}</Badge> : undefined}>
          {account ? (
            <form className="form-stack" onSubmit={(event) => void saveCredit(event)}>
              <div className="metric-grid">
                <Card><span className="metric-label">Outstanding</span><span className="metric-value">{account.outstandingBalance}</span><span className="metric-note">KES</span></Card>
                <Card><span className="metric-label">Available</span><span className="metric-value">{account.availableCredit}</span><span className="metric-note">KES</span></Card>
              </div>
              <div className="form-grid">
                <SelectField label="Status" value={creditForm.creditStatus} onChange={(event) => setCreditForm({ ...creditForm, creditStatus: event.target.value as typeof creditForm.creditStatus })} disabled={!canManage}>
                  <option value="disabled">Disabled</option>
                  <option value="active">Active</option>
                  <option value="hold">On hold</option>
                </SelectField>
                <TextField label="Credit limit" inputMode="decimal" value={creditForm.creditLimit} onChange={(event) => setCreditForm({ ...creditForm, creditLimit: event.target.value })} disabled={!canManage} required />
                <TextField label="Terms days" inputMode="numeric" value={creditForm.paymentTermsDays} onChange={(event) => setCreditForm({ ...creditForm, paymentTermsDays: event.target.value })} disabled={!canManage} required />
                <TextField label="Reason" value={creditForm.reason} onChange={(event) => setCreditForm({ ...creditForm, reason: event.target.value })} disabled={!canManage} required />
              </div>
              <Button type="submit" variant="secondary" disabled={!canManage} loading={submitting}>Save credit settings</Button>
            </form>
          ) : <EmptyState title="No account selected" description="Select a customer to view balances and transactions." />}
        </Card>
      </div>

      {account ? (
        <>
          <div className="dashboard-grid dashboard-grid-wide">
            <Card title="Collect payment" subtitle="Cash collections post to an open register session and allocate to eligible credit sales.">
              <form className="form-stack" onSubmit={(event) => void recordPayment(event)}>
                <SelectField label="Open drawer" value={paymentForm.registerSessionId} onChange={(event) => setPaymentForm({ ...paymentForm, registerSessionId: event.target.value })} required>
                  <option value="">Select session</option>
                  {openSessions.map((session) => <option key={session.id} value={session.id}>{session.registerName ?? session.registerCode} · {session.branchName}</option>)}
                </SelectField>
                <div className="form-grid">
                  <TextField label="Cash received" inputMode="decimal" value={paymentForm.amount} onChange={(event) => setPaymentForm({ ...paymentForm, amount: event.target.value })} required />
                  <TextField label="Reason / reference" value={paymentForm.reason} onChange={(event) => setPaymentForm({ ...paymentForm, reason: event.target.value })} required />
                </div>
                <div className="table-wrap">
                  <table>
                    <thead><tr><th>Invoice</th><th>Due</th><th>Outstanding</th><th>Allocate</th></tr></thead>
                    <tbody>
                      {outstanding.map((sale) => (
                        <tr key={sale.saleId}>
                          <td>{sale.receiptNumber}<small className="table-subtext">{sale.branchName}</small></td>
                          <td>{sale.dueDate ?? '—'}{sale.overdue ? <Badge tone="danger">Overdue</Badge> : null}</td>
                          <td>{sale.outstanding}</td>
                          <td><input aria-label={`Allocate to ${sale.receiptNumber}`} inputMode="decimal" max={sale.outstanding} value={allocations[sale.saleId] ?? ''} onChange={(event) => setAllocations({ ...allocations, [sale.saleId]: event.target.value })} /></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <span className="form-hint">Allocated {allocatedTotal} of {paymentForm.amount || '0'} received. Unallocated cash remains on account.</span>
                <Button type="submit" disabled={!canCollect || !outstanding.length} loading={submitting}>Record payment</Button>
              </form>
            </Card>

            <Card title="Account adjustment" subtitle="Debit adjustments increase debt; credit adjustments and write-offs allocate to selected invoices.">
              <form className="form-stack" onSubmit={(event) => void postAdjustment(event)}>
                <div className="form-grid">
                  <SelectField label="Type" value={adjustmentForm.type} onChange={(event) => setAdjustmentForm({ ...adjustmentForm, type: event.target.value as typeof adjustmentForm.type })} disabled={!canAdjust}>
                    <option value="debit_adjustment">Debit adjustment</option>
                    <option value="credit_adjustment">Credit adjustment</option>
                    {canWriteOff ? <option value="write_off">Write-off</option> : null}
                  </SelectField>
                  <SelectField label="Branch" value={adjustmentForm.branchId} onChange={(event) => setAdjustmentForm({ ...adjustmentForm, branchId: event.target.value })} disabled={Boolean(adjustmentForm.saleId)}>
                    {bootstrap?.branches.map((branch) => <option key={branch.id} value={branch.id}>{branch.name}</option>)}
                  </SelectField>
                  <TextField label="Amount" inputMode="decimal" value={adjustmentForm.amount} onChange={(event) => setAdjustmentForm({ ...adjustmentForm, amount: event.target.value })} required />
                  <SelectField label="Allocate to sale" value={adjustmentForm.saleId} onChange={(event) => setAdjustmentForm({ ...adjustmentForm, saleId: event.target.value, branchId: outstanding.find((sale) => sale.saleId === event.target.value)?.branchId ?? adjustmentForm.branchId })} disabled={adjustmentForm.type === 'debit_adjustment'} required={adjustmentForm.type !== 'debit_adjustment'}>
                    <option value="">Select outstanding sale</option>
                    {outstanding.map((sale) => <option key={sale.saleId} value={sale.saleId}>{sale.receiptNumber} · {sale.outstanding}</option>)}
                  </SelectField>
                </div>
                <TextField label="Mandatory reason" value={adjustmentForm.reason} onChange={(event) => setAdjustmentForm({ ...adjustmentForm, reason: event.target.value })} required />
                <Button type="submit" variant="secondary" disabled={!canAdjust} loading={submitting}>Post adjustment</Button>
              </form>
            </Card>
          </div>

          <Card title="Outstanding invoices" subtitle="Balances derive from the credit ledger and sale allocations.">
            {outstanding.length ? (
              <div className="table-wrap">
                <table>
                  <thead><tr><th>Receipt</th><th>Branch</th><th>Sold</th><th>Due</th><th>Total</th><th>Allocated</th><th>Outstanding</th></tr></thead>
                  <tbody>{outstanding.map((sale) => <tr key={sale.saleId}><td>{sale.receiptNumber}</td><td>{sale.branchName}</td><td>{shortDate(sale.soldAt)}</td><td>{sale.dueDate ?? '—'}</td><td>{sale.total}</td><td>{sale.allocated}</td><td>{sale.outstanding}</td></tr>)}</tbody>
                </table>
              </div>
            ) : <EmptyState title="No outstanding credit" description="Credit sales and unallocated balances will appear here." />}
          </Card>

          <Card title="Account statement" subtitle="Immutable debit and credit transactions.">
            {transactions.length ? (
              <div className="table-wrap">
                <table>
                  <thead><tr><th>Date</th><th>Type</th><th>Reference</th><th>Debit</th><th>Credit</th><th>Reason</th><th>Actor</th></tr></thead>
                  <tbody>
                    {transactions.map((transaction) => (
                      <tr key={transaction.id}>
                        <td>{shortDate(transaction.createdAt)}</td>
                        <td><Badge tone={transaction.direction === 'debit' ? 'warning' : 'success'}>{transaction.transactionType.replaceAll('_', ' ')}</Badge></td>
                        <td>{transaction.receiptNumber ?? transaction.referenceType ?? '—'}</td>
                        <td>{transaction.direction === 'debit' ? transaction.amount : '—'}</td>
                        <td>{transaction.direction === 'credit' ? transaction.amount : '—'}</td>
                        <td>{transaction.reason ?? '—'}</td>
                        <td>{transaction.actorName ?? 'System'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : <EmptyState title="No account transactions" description="Credit sales, payments and adjustments will appear here." />}
          </Card>
        </>
      ) : null}
    </div>
  );
}
