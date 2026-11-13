import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { Alert, Badge, Button, Card, ConfirmDialog, EmptyState, PageHeader, SelectField, Spinner, TextField } from '../../design-system/components';
import { useAuth } from '../../app/useAuth';
import { api, ApiError } from '../../lib/api/client';
import type { Expense, ExpenseCategory, Paged, RegisterSession, Supplier } from '../../lib/api/types';

type PaymentMethod = 'cash' | 'bank_transfer' | 'mobile_money' | 'other';

interface ExpenseForm {
  categoryId: string;
  description: string;
  businessPurpose: string;
  expenseDate: string;
  amount: string;
  paymentMethod: PaymentMethod;
  payeeName: string;
  supplierId: string;
  supportingDocumentRef: string;
  supportingDocumentName: string;
}

function emptyExpenseForm(categoryId = ''): ExpenseForm {
  return {
    categoryId,
    description: '',
    businessPurpose: '',
    expenseDate: new Date().toISOString().slice(0, 10),
    amount: '',
    paymentMethod: 'cash',
    payeeName: '',
    supplierId: '',
    supportingDocumentRef: '',
    supportingDocumentName: ''
  };
}

function shortDate(value?: string | null) {
  return value ? new Date(value).toLocaleDateString('en-KE', { dateStyle: 'medium' }) : '—';
}

function statusTone(status: string): 'success' | 'warning' | 'danger' | 'info' {
  if (['paid', 'approved', 'active'].includes(status)) return 'success';
  if (['draft', 'submitted', 'pending'].includes(status)) return 'warning';
  if (['rejected', 'cancelled', 'inactive'].includes(status)) return 'danger';
  return 'info';
}

export function ExpensesPage() {
  const { bootstrap, hasPermission } = useAuth();
  const canCreate = hasPermission('expense.create');
  const canSubmit = hasPermission('expense.submit');
  const canApprove = hasPermission('expense.approve');
  const canReject = hasPermission('expense.reject');
  const canPay = hasPermission('expense.pay');
  const canCancel = hasPermission('expense.cancel');
  const canAdjust = hasPermission('expense.adjust');
  const canManageCategories = hasPermission('expense-category.manage');
  const canExport = hasPermission('reports.export');
  const canReadSuppliers = hasPermission('supplier.read');
  const canViewUsers = hasPermission('user.read');
  const canViewSessions = hasPermission('sales.view');
  const branches = useMemo(() => bootstrap?.branches ?? [], [bootstrap?.branches]);

  const [categories, setCategories] = useState<ExpenseCategory[]>([]);
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [sessions, setSessions] = useState<RegisterSession[]>([]);
  const [memberships, setMemberships] = useState<Array<{ id: string; displayName: string; email: string }>>([]);
  const [expenses, setExpenses] = useState<Paged<Expense> | null>(null);
  const [selected, setSelected] = useState<Expense | null>(null);
  const [editingId, setEditingId] = useState('');
  const [filters, setFilters] = useState({
    branchId: '',
    categoryId: '',
    status: '',
    paymentMethod: '',
    supplierId: '',
    createdByMembershipId: '',
    approvedByMembershipId: '',
    search: '',
    from: '',
    to: ''
  });
  const [appliedFilters, setAppliedFilters] = useState(filters);
  const [page, setPage] = useState(1);
  const [categoryForm, setCategoryForm] = useState({ code: '', name: '', description: '' });
  const [expenseForm, setExpenseForm] = useState<ExpenseForm>(emptyExpenseForm());
  const [decisionReason, setDecisionReason] = useState('');
  const [paymentForm, setPaymentForm] = useState({ registerSessionId: '', reason: '', paymentReference: '' });
  const [pendingAction, setPendingAction] = useState<'approve' | 'reject' | 'cancel' | 'pay' | null>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  const effectiveBranch = filters.branchId || appliedFilters.branchId || branches[0]?.id || '';
  const openSessions = useMemo(() => sessions.filter((session) => session.status === 'open' && session.branchId === (selected?.branchId ?? effectiveBranch)), [sessions, selected?.branchId, effectiveBranch]);
  const activeCategories = useMemo(() => categories.filter((category) => category.status === 'active'), [categories]);

  const loadExpense = useCallback(async (expenseId: string) => {
    const result = await api.expense(expenseId);
    setSelected(result.expense);
    setPaymentForm((form) => ({ ...form, registerSessionId: form.registerSessionId || openSessions[0]?.id || '' }));
  }, [openSessions]);

  const load = useCallback(async (nextPage = page) => {
    setError('');
    try {
      const [categoryResult, supplierResult, sessionResult, membershipResult, expenseResult] = await Promise.all([
        api.expenseCategories(),
        canReadSuppliers ? api.suppliers({ pageSize: 50 }) : Promise.resolve({ items: [] as Supplier[] }),
        canViewSessions ? api.registerSessions({ pageSize: 50 }) : Promise.resolve({ sessions: [] as RegisterSession[] }),
        canViewUsers ? api.users() : Promise.resolve({ users: [] }),
        api.expenses({ ...appliedFilters, page: nextPage, pageSize: 15 })
      ]);
      setCategories(categoryResult.categories);
      setSuppliers(supplierResult.items);
      setSessions(sessionResult.sessions);
      setMemberships(membershipResult.users);
      setExpenses(expenseResult);
      setPage(nextPage);
      if (selected && !expenseResult.items.some((expense) => expense.id === selected.id)) setSelected(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Unable to load expenses.');
    } finally {
      setLoading(false);
    }
  }, [appliedFilters, canReadSuppliers, canViewSessions, canViewUsers, page, selected]);

  useEffect(() => {
    setLoading(true);
    void load(1);
  }, [load]);

  useEffect(() => {
    setExpenseForm((form) => form.categoryId ? form : { ...form, categoryId: activeCategories[0]?.id ?? '' });
  }, [activeCategories]);

  useEffect(() => {
    setFilters((form) => form.branchId ? form : { ...form, branchId: branches[0]?.id ?? '' });
  }, [branches]);

  useEffect(() => {
    setAppliedFilters((current) => current.branchId || !filters.branchId ? current : { ...current, branchId: filters.branchId });
  }, [filters.branchId]);

  async function createCategory(event: FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setError('');
    try {
      const result = await api.createExpenseCategory({ code: categoryForm.code, name: categoryForm.name, description: categoryForm.description || null, status: 'active' });
      setCategoryForm({ code: '', name: '', description: '' });
      setMessage(`Expense category ${result.category.name} created.`);
      await load(page);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Unable to create expense category.');
    } finally {
      setSubmitting(false);
    }
  }

  async function saveExpense(event: FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setError('');
    try {
      if (editingId) {
        const result = await api.updateExpense(editingId, {
          categoryId: expenseForm.categoryId,
          description: expenseForm.description,
          businessPurpose: expenseForm.businessPurpose || null,
          expenseDate: expenseForm.expenseDate,
          amount: expenseForm.amount,
          paymentMethod: expenseForm.paymentMethod,
          payeeName: expenseForm.payeeName || null,
          supplierId: expenseForm.supplierId || null,
          supportingDocumentRef: expenseForm.supportingDocumentRef || null,
          supportingDocumentName: expenseForm.supportingDocumentName || null,
          reason: selected?.status === 'submitted' ? decisionReason : undefined
        });
        setMessage(`Expense ${result.expense.expenseNumber} updated.`);
        await loadExpense(editingId);
      } else {
        const result = await api.createExpense({
          clientTransactionId: crypto.randomUUID(),
          branchId: effectiveBranch,
          categoryId: expenseForm.categoryId,
          description: expenseForm.description,
          businessPurpose: expenseForm.businessPurpose || null,
          expenseDate: expenseForm.expenseDate,
          amount: expenseForm.amount,
          currencyCode: bootstrap?.organization.currencyCode,
          paymentMethod: expenseForm.paymentMethod,
          payeeName: expenseForm.payeeName || null,
          supplierId: expenseForm.supplierId || null,
          supportingDocumentRef: expenseForm.supportingDocumentRef || null,
          supportingDocumentName: expenseForm.supportingDocumentName || null
        });
        setEditingId('');
        setMessage(`Expense ${result.expense.expenseNumber} created as a draft.`);
        await loadExpense(result.expense.id);
      }
      setExpenseForm(emptyExpenseForm(activeCategories[0]?.id ?? ''));
      await load(page);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Unable to save expense.');
    } finally {
      setSubmitting(false);
    }
  }

  function beginEdit(expense: Expense) {
    setEditingId(expense.id);
    setExpenseForm({
      categoryId: expense.categoryId,
      description: expense.description,
      businessPurpose: expense.businessPurpose ?? '',
      expenseDate: expense.expenseDate,
      amount: expense.amount,
      paymentMethod: expense.paymentMethod,
      payeeName: expense.payeeName ?? '',
      supplierId: expense.supplierId ?? '',
      supportingDocumentRef: expense.supportingDocumentRef ?? '',
      supportingDocumentName: expense.supportingDocumentName ?? ''
    });
  }

  async function runAction(action: 'approve' | 'reject' | 'cancel' | 'pay') {
    if (!selected) return;
    setSubmitting(true);
    setError('');
    try {
      const result = action === 'approve'
        ? await api.approveExpense(selected.id, decisionReason)
        : action === 'reject'
          ? await api.rejectExpense(selected.id, decisionReason)
          : action === 'cancel'
            ? await api.cancelExpense(selected.id, decisionReason)
            : await api.payExpense(selected.id, {
                clientTransactionId: crypto.randomUUID(),
                registerSessionId: selected.paymentMethod === 'cash' ? paymentForm.registerSessionId : undefined,
                reason: paymentForm.reason,
                paymentReference: selected.paymentMethod === 'cash' ? null : paymentForm.paymentReference
              });
      setPendingAction(null);
      setDecisionReason('');
      setPaymentForm((form) => ({ ...form, reason: '', paymentReference: '' }));
      setSelected(result.expense);
      const actionLabel = action === 'approve' ? 'approved' : action === 'reject' ? 'rejected' : action === 'cancel' ? 'cancelled' : '';
      setMessage(`Expense ${result.expense.expenseNumber} ${action === 'pay' ? (result.expense.paymentMethod === 'cash' ? 'paid' : 'recorded as pending') : actionLabel}.`);
      await load(page);
    } catch (err) {
      setPendingAction(null);
      setError(err instanceof ApiError ? err.message : 'The expense action failed.');
    } finally {
      setSubmitting(false);
    }
  }

  async function submitSelected() {
    if (!selected) return;
    setSubmitting(true);
    setError('');
    try {
      const result = await api.submitExpense(selected.id);
      setSelected(result.expense);
      setMessage(`Expense ${result.expense.expenseNumber} submitted for approval.`);
      await load(page);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Unable to submit expense.');
    } finally {
      setSubmitting(false);
    }
  }

  async function toggleCategory(category: ExpenseCategory) {
    setSubmitting(true);
    setError('');
    try {
      const status = category.status === 'active' ? 'inactive' : 'active';
      const result = await api.updateExpenseCategory(category.id, { status });
      setMessage(`Expense category ${result.category.name} ${status === 'active' ? 'reactivated' : 'deactivated'}.`);
      await load(page);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Unable to update the expense category.');
    } finally {
      setSubmitting(false);
    }
  }

  async function exportCsv() {
    setSubmitting(true);
    setError('');
    try {
      const csv = await api.exportExpenses(appliedFilters);
      const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = `expenses-${new Date().toISOString().slice(0, 10)}.csv`;
      link.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Unable to export expenses.');
    } finally {
      setSubmitting(false);
    }
  }

  if (loading) return <Spinner label="Loading expense management" />;

  return (
    <div className="page-stack">
      <PageHeader
        title="Expenses"
        description="Draft, approve, pay and audit operating expenses with branch-scoped reporting."
        actions={canExport ? <Button variant="secondary" loading={submitting} onClick={() => void exportCsv()}>Export CSV</Button> : null}
      />
      {message ? <Alert tone="success">{message}</Alert> : null}
      {error ? <Alert tone="danger">{error}</Alert> : null}

      <Card title="Expense filters" subtitle="Filter the expense register by branch, status, category and date.">
        <form className="inline-form" onSubmit={(event) => { event.preventDefault(); setAppliedFilters(filters); setPage(1); }}>
          <SelectField label="Branch" value={filters.branchId} onChange={(event) => setFilters({ ...filters, branchId: event.target.value })}>
            {branches.map((branch) => <option key={branch.id} value={branch.id}>{branch.name}</option>)}
          </SelectField>
          <SelectField label="Category" value={filters.categoryId} onChange={(event) => setFilters({ ...filters, categoryId: event.target.value })}>
            <option value="">All categories</option>
            {categories.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}
          </SelectField>
          <SelectField label="Status" value={filters.status} onChange={(event) => setFilters({ ...filters, status: event.target.value })}>
            <option value="">All statuses</option>
            {['draft', 'submitted', 'approved', 'rejected', 'paid', 'cancelled'].map((status) => <option key={status} value={status}>{status}</option>)}
          </SelectField>
          <SelectField label="Payment method" value={filters.paymentMethod} onChange={(event) => setFilters({ ...filters, paymentMethod: event.target.value })}>
            <option value="">All methods</option>
            {['cash', 'bank_transfer', 'mobile_money', 'other'].map((method) => <option key={method} value={method}>{method}</option>)}
          </SelectField>
          {canReadSuppliers ? (
            <SelectField label="Supplier" value={filters.supplierId} onChange={(event) => setFilters({ ...filters, supplierId: event.target.value })}>
              <option value="">All suppliers</option>
              {suppliers.map((supplier) => <option key={supplier.id} value={supplier.id}>{supplier.name}</option>)}
            </SelectField>
          ) : null}
          {canViewUsers ? (
            <>
              <SelectField label="Created by" value={filters.createdByMembershipId} onChange={(event) => setFilters({ ...filters, createdByMembershipId: event.target.value })}>
                <option value="">All creators</option>
                {memberships.map((member) => <option key={member.id} value={member.id}>{member.displayName}</option>)}
              </SelectField>
              <SelectField label="Approved by" value={filters.approvedByMembershipId} onChange={(event) => setFilters({ ...filters, approvedByMembershipId: event.target.value })}>
                <option value="">All approvers</option>
                {memberships.map((member) => <option key={member.id} value={member.id}>{member.displayName}</option>)}
              </SelectField>
            </>
          ) : null}
          <TextField label="Search" value={filters.search} onChange={(event) => setFilters({ ...filters, search: event.target.value })} placeholder="Number, description or payee" />
          <TextField label="From" type="date" value={filters.from} onChange={(event) => setFilters({ ...filters, from: event.target.value })} />
          <TextField label="To" type="date" value={filters.to} onChange={(event) => setFilters({ ...filters, to: event.target.value })} />
          <Button type="submit">Apply filters</Button>
          <Button type="button" variant="secondary" onClick={() => {
            const empty = { ...filters, categoryId: '', status: '', paymentMethod: '', supplierId: '', createdByMembershipId: '', approvedByMembershipId: '', search: '', from: '', to: '' };
            setFilters(empty);
            setAppliedFilters(empty);
            setPage(1);
          }}>Clear</Button>
        </form>
      </Card>

      <div className="dashboard-grid dashboard-grid-wide">
        <Card title="Expense register" subtitle={`${expenses?.total ?? 0} records in the selected scope.`}>
          {!expenses?.items.length ? (
            <EmptyState title="No expenses found" description="Create a draft expense or broaden the filters." />
          ) : (
            <>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr><th>Expense</th><th>Category</th><th>Amount</th><th>Status</th><th>Payment</th></tr>
                  </thead>
                  <tbody>
                    {expenses.items.map((expense) => (
                      <tr
                        key={expense.id}
                        className={selected?.id === expense.id ? 'row-selected' : ''}
                        tabIndex={0}
                        onClick={() => void loadExpense(expense.id)}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter' || event.key === ' ') {
                            event.preventDefault();
                            void loadExpense(expense.id);
                          }
                        }}
                      >
                        <td><strong>{expense.expenseNumber}</strong><span className="table-subtext">{shortDate(expense.expenseDate)} · {expense.branchName}</span></td>
                        <td>{expense.categoryName}</td>
                        <td>{expense.currencyCode} {expense.amount}</td>
                        <td><Badge tone={statusTone(expense.status)}>{expense.status}</Badge></td>
                        <td><Badge tone={statusTone(expense.paymentStatus)}>{expense.paymentStatus}</Badge></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="table-actions">
                <Button variant="secondary" disabled={page <= 1} onClick={() => void load(page - 1)}>Previous</Button>
                <span>Page {page} of {expenses.totalPages}</span>
                <Button variant="secondary" disabled={page >= expenses.totalPages} onClick={() => void load(page + 1)}>Next</Button>
              </div>
            </>
          )}
        </Card>

        <Card title={editingId ? 'Edit expense' : 'Create draft expense'} subtitle="Drafts do not count as approved or paid expenses.">
          {canCreate ? (
            <form className="form-grid" onSubmit={saveExpense}>
              <SelectField label="Category" value={expenseForm.categoryId} onChange={(event) => setExpenseForm({ ...expenseForm, categoryId: event.target.value })} required>
                {activeCategories.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}
              </SelectField>
              <TextField label="Expense date" type="date" value={expenseForm.expenseDate} onChange={(event) => setExpenseForm({ ...expenseForm, expenseDate: event.target.value })} required />
              <TextField label="Description" value={expenseForm.description} onChange={(event) => setExpenseForm({ ...expenseForm, description: event.target.value })} required />
              <TextField label="Business purpose" value={expenseForm.businessPurpose} onChange={(event) => setExpenseForm({ ...expenseForm, businessPurpose: event.target.value })} />
              <TextField label="Amount (KES)" inputMode="decimal" value={expenseForm.amount} onChange={(event) => setExpenseForm({ ...expenseForm, amount: event.target.value })} required />
              <SelectField label="Payment method" value={expenseForm.paymentMethod} onChange={(event) => setExpenseForm({ ...expenseForm, paymentMethod: event.target.value as PaymentMethod })}>
                <option value="cash">Cash drawer</option>
                <option value="bank_transfer">Bank transfer</option>
                <option value="mobile_money">Mobile money</option>
                <option value="other">Other channel</option>
              </SelectField>
              <TextField label="Payee" value={expenseForm.payeeName} onChange={(event) => setExpenseForm({ ...expenseForm, payeeName: event.target.value })} />
              <SelectField label="Supplier" value={expenseForm.supplierId} onChange={(event) => setExpenseForm({ ...expenseForm, supplierId: event.target.value })}>
                <option value="">No supplier</option>
                {suppliers.map((supplier) => <option key={supplier.id} value={supplier.id}>{supplier.name}</option>)}
              </SelectField>
              <TextField label="Document reference" value={expenseForm.supportingDocumentRef} onChange={(event) => setExpenseForm({ ...expenseForm, supportingDocumentRef: event.target.value })} />
              <TextField label="Document name" value={expenseForm.supportingDocumentName} onChange={(event) => setExpenseForm({ ...expenseForm, supportingDocumentName: event.target.value })} />
              {editingId && selected?.status === 'submitted' ? <TextField label="Adjustment reason" value={decisionReason} onChange={(event) => setDecisionReason(event.target.value)} required /> : null}
              <Button type="submit" loading={submitting}>{editingId ? 'Save adjustment' : 'Create draft'}</Button>
              {editingId ? <Button type="button" variant="secondary" onClick={() => { setEditingId(''); setExpenseForm(emptyExpenseForm(activeCategories[0]?.id ?? '')); }}>Cancel edit</Button> : null}
            </form>
          ) : <EmptyState title="Expense creation unavailable" description="Your role does not have expense.create permission." />}
        </Card>
      </div>

      <div className="dashboard-grid">
        <Card title="Selected expense" subtitle="Status history, payment evidence and authorized actions.">
          {!selected ? (
            <EmptyState title="Select an expense" description="Choose a row in the register to review or continue its workflow." />
          ) : (
            <div className="detail-stack">
              <div className="list-row">
                <div><strong>{selected.expenseNumber}</strong><span>{selected.description}</span></div>
                <Badge tone={statusTone(selected.status)}>{selected.status}</Badge>
              </div>
              <dl className="detail-list">
                <div><dt>Amount</dt><dd>{selected.currencyCode} {selected.amount}</dd></div>
                <div><dt>Branch</dt><dd>{selected.branchName}</dd></div>
                <div><dt>Category</dt><dd>{selected.categoryName}</dd></div>
                <div><dt>Method</dt><dd>{selected.paymentMethod}</dd></div>
                <div><dt>Payee</dt><dd>{selected.payeeName ?? selected.supplierName ?? '—'}</dd></div>
                <div><dt>Payment status</dt><dd>{selected.paymentStatus}</dd></div>
                <div><dt>Created by</dt><dd>{selected.createdByName}</dd></div>
              </dl>
              <div className="table-actions">
                {selected.status === 'draft' && canCreate ? <Button variant="secondary" onClick={() => beginEdit(selected)}>Edit</Button> : null}
                {selected.status === 'submitted' && canAdjust ? <Button variant="secondary" onClick={() => beginEdit(selected)}>Adjust</Button> : null}
                {selected.status === 'draft' && canSubmit ? <Button onClick={() => void submitSelected()} loading={submitting}>Submit</Button> : null}
                {selected.status === 'submitted' && canApprove ? <Button disabled={!decisionReason.trim()} onClick={() => setPendingAction('approve')}>Approve</Button> : null}
                {selected.status === 'submitted' && canReject ? <Button variant="danger" disabled={!decisionReason.trim()} onClick={() => setPendingAction('reject')}>Reject</Button> : null}
                {['draft', 'submitted', 'approved'].includes(selected.status) && selected.paymentStatus !== 'paid' && canCancel ? <Button variant="danger" disabled={!decisionReason.trim()} onClick={() => setPendingAction('cancel')}>Cancel</Button> : null}
                {selected.status === 'approved' && selected.paymentStatus === 'unpaid' && canPay ? (
                  <Button
                    disabled={!paymentForm.reason.trim() || (selected.paymentMethod === 'cash' && !paymentForm.registerSessionId) || (selected.paymentMethod !== 'cash' && !paymentForm.paymentReference.trim())}
                    onClick={() => setPendingAction('pay')}
                  >
                    Record payment
                  </Button>
                ) : null}
              </div>
              <TextField label="Workflow reason" value={decisionReason} onChange={(event) => setDecisionReason(event.target.value)} hint="Required for approval, rejection or cancellation." />
              {selected.status === 'approved' && selected.paymentStatus === 'unpaid' ? (
                <div className="form-grid">
                  {selected.paymentMethod === 'cash' ? (
                    <SelectField label="Open register session" value={paymentForm.registerSessionId} onChange={(event) => setPaymentForm({ ...paymentForm, registerSessionId: event.target.value })}>
                      <option value="">Select a drawer</option>
                      {openSessions.map((session) => <option key={session.id} value={session.id}>{session.registerName ?? session.registerCode} · {session.branchName}</option>)}
                    </SelectField>
                  ) : (
                    <TextField label="Payment reference" value={paymentForm.paymentReference} onChange={(event) => setPaymentForm({ ...paymentForm, paymentReference: event.target.value })} />
                  )}
                  <TextField label="Payment reason" value={paymentForm.reason} onChange={(event) => setPaymentForm({ ...paymentForm, reason: event.target.value })} required />
                </div>
              ) : null}
              <div className="table-wrap">
                <table>
                  <thead><tr><th>Event</th><th>Actor</th><th>Reason</th><th>Time</th></tr></thead>
                  <tbody>
                    {(selected.events ?? []).map((event) => (
                      <tr key={event.id}>
                        <td>{event.eventType}</td>
                        <td>{event.actorName}</td>
                        <td>{event.reason ?? '—'}</td>
                        <td>{new Date(event.createdAt).toLocaleString('en-KE')}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </Card>

        <Card title="Expense categories" subtitle="Reusable operating categories for reporting and approvals.">
          {canManageCategories ? (
            <form className="form-grid" onSubmit={createCategory}>
              <TextField label="Code" value={categoryForm.code} onChange={(event) => setCategoryForm({ ...categoryForm, code: event.target.value.toUpperCase() })} required />
              <TextField label="Name" value={categoryForm.name} onChange={(event) => setCategoryForm({ ...categoryForm, name: event.target.value })} required />
              <TextField label="Description" value={categoryForm.description} onChange={(event) => setCategoryForm({ ...categoryForm, description: event.target.value })} />
              <Button type="submit" loading={submitting}>Add category</Button>
            </form>
          ) : null}
          <div className="list-stack">
            {categories.map((category) => (
              <div className="list-row" key={category.id}>
                <div><strong>{category.name}</strong><span>{category.code} · {category.description ?? 'No description'}</span></div>
                <div className="table-actions">
                  <Badge tone={category.status === 'active' ? 'success' : 'danger'}>{category.status}</Badge>
                  {canManageCategories ? <Button variant="secondary" disabled={submitting} onClick={() => void toggleCategory(category)}>{category.status === 'active' ? 'Deactivate' : 'Activate'}</Button> : null}
                </div>
              </div>
            ))}
          </div>
        </Card>
      </div>

      <ConfirmDialog
        open={pendingAction !== null}
        title={pendingAction === 'pay' ? 'Confirm expense payment' : `Confirm expense ${pendingAction}`}
        description={pendingAction === 'pay'
          ? selected?.paymentMethod === 'cash'
            ? 'This will post a real cash-out movement to the selected open register and mark the expense paid.'
            : 'This records a pending non-cash payment request. The expense will not be marked paid until the channel is supported and completed.'
          : 'This workflow change is audited and cannot be silently undone.'}
        confirmLabel={pendingAction === 'pay' ? 'Record payment' : 'Confirm'}
        danger={pendingAction === 'reject' || pendingAction === 'cancel'}
        onCancel={() => setPendingAction(null)}
        onConfirm={() => pendingAction && void runAction(pendingAction)}
      />
    </div>
  );
}
