import { unitLabel } from '@pos/contracts';
import type { OperationsReportQuery } from '@pos/contracts';
import type pg from 'pg';
import type { Queryable } from '../../database/pool.js';
import { listAccessibleBranchIds, membershipHasBranchAccess, type AuthContext } from '../../http/middleware/auth.js';
import { forbidden } from '../../shared/errors.js';
import { minorUnitsToDecimal } from '../../shared/money.js';

async function ensureBranch(db: Queryable, auth: AuthContext, branchId: string): Promise<void> {
  if (!(await membershipHasBranchAccess(db, auth, branchId))) {
    throw forbidden('BRANCH_ACCESS_DENIED', 'Branch access denied');
  }
}

function minor(row: Record<string, unknown>, key: string): string {
  return minorUnitsToDecimal(String(row[key] ?? 0));
}

function mapBreakdown(row: Record<string, unknown>) {
  return {
    id: row.id,
    name: row.name,
    count: Number(row.count),
    submitted: minor(row, 'submitted_minor'),
    approved: minor(row, 'approved_minor'),
    paid: minor(row, 'paid_minor'),
    total: minor(row, 'authorized_minor')
  };
}

function csvCell(value: unknown): string {
  let text = value === null || value === undefined ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

export async function getOperationsReport(pool: pg.Pool, auth: AuthContext, query: OperationsReportQuery) {
  if (query.branchId) await ensureBranch(pool, auth, query.branchId);
  const branchIds = query.branchId ? [query.branchId] : await listAccessibleBranchIds(pool, auth);
  if (branchIds.length === 0) throw forbidden('BRANCH_ACCESS_DENIED', 'No accessible branches');

  const organization = await pool.query<{ currency_code: string; timezone: string; display_name: string }>(
    'SELECT currency_code, timezone, display_name FROM organizations WHERE id = $1',
    [auth.organizationId]
  );
  const org = organization.rows[0]!;
  const from = query.from ?? null;
  const to = query.to ?? null;

  const sales = await pool.query<Record<string, unknown>>(
    `SELECT
       COUNT(*)::text AS sale_count,
       COALESCE(SUM(s.total_minor),0)::text AS gross_sales_minor,
       COALESCE(SUM(s.discount_total_minor),0)::text AS discounts_minor,
       COALESCE(SUM(s.tax_total_minor),0)::text AS tax_minor,
       COALESCE(SUM(s.total_cost_minor),0)::text AS cost_minor,
       COALESCE(SUM(sp.cash_minor),0)::text AS cash_sales_minor,
       COALESCE(SUM(sp.credit_minor),0)::text AS credit_sales_minor,
       COALESCE(SUM(sp.mpesa_minor),0)::text AS mpesa_sales_minor,
       COALESCE(SUM(sp.card_minor),0)::text AS card_sales_minor,
       COALESCE(SUM(sp.test_minor),0)::text AS test_sales_minor,
       COALESCE(SUM((
         SELECT SUM(rl.refund_amount_minor)
         FROM sale_return_lines rl
         JOIN sale_returns r ON r.id = rl.sale_return_id AND r.organization_id = rl.organization_id
         WHERE r.sale_id = s.id AND r.organization_id = s.organization_id AND r.status = 'posted'
       )),0)::text AS returned_minor,
       COALESCE(SUM((
         SELECT SUM(sr.amount_minor)
         FROM sale_refunds sr
         WHERE sr.sale_id = s.id AND sr.organization_id = s.organization_id AND sr.status = 'completed'
       )),0)::text AS refunded_minor
     FROM sales s
     LEFT JOIN (
       SELECT organization_id, sale_id,
              SUM(amount_minor) FILTER (WHERE method = 'cash') AS cash_minor,
              SUM(amount_minor) FILTER (WHERE method = 'credit') AS credit_minor,
              SUM(amount_minor) FILTER (WHERE method = 'mpesa') AS mpesa_minor,
              SUM(amount_minor) FILTER (WHERE method = 'card') AS card_minor,
              SUM(amount_minor) FILTER (WHERE verification IN ('simulated','sandbox')) AS test_minor
       FROM sale_payments
       GROUP BY organization_id, sale_id
     ) sp ON sp.sale_id = s.id AND sp.organization_id = s.organization_id
     WHERE s.organization_id = $1
       AND s.branch_id = ANY($2::uuid[])
       AND s.status <> 'voided'
       AND ($4::date IS NULL OR (s.sold_at AT TIME ZONE $3)::date >= $4::date)
       AND ($5::date IS NULL OR (s.sold_at AT TIME ZONE $3)::date <= $5::date)`,
    [auth.organizationId, branchIds, org.timezone, from, to]
  );

  const expenseSummary = await pool.query<Record<string, unknown>>(
    `SELECT
       COUNT(*)::text AS expense_count,
       COALESCE(SUM(amount_minor) FILTER (WHERE status = 'draft'),0)::text AS draft_minor,
       COALESCE(SUM(amount_minor) FILTER (WHERE status = 'submitted'),0)::text AS submitted_minor,
       COALESCE(SUM(amount_minor) FILTER (WHERE status = 'approved'),0)::text AS approved_minor,
       COALESCE(SUM(amount_minor) FILTER (WHERE status = 'paid'),0)::text AS paid_minor,
       COALESCE(SUM(amount_minor) FILTER (WHERE payment_status = 'pending'),0)::text AS pending_minor,
       COALESCE(SUM(amount_minor) FILTER (WHERE status IN ('approved','paid')),0)::text AS authorized_minor
     FROM expenses e
     WHERE e.organization_id = $1
       AND e.branch_id = ANY($2::uuid[])
       AND ($3::date IS NULL OR e.expense_date >= $3::date)
       AND ($4::date IS NULL OR e.expense_date <= $4::date)`,
    [auth.organizationId, branchIds, from, to]
  );

  const expenseCategories = await pool.query<Record<string, unknown>>(
    `SELECT e.category_id AS id, e.category_name AS name,
            COUNT(*)::text AS count,
            COALESCE(SUM(e.amount_minor) FILTER (WHERE e.status = 'submitted'),0)::text AS submitted_minor,
            COALESCE(SUM(e.amount_minor) FILTER (WHERE e.status = 'approved'),0)::text AS approved_minor,
            COALESCE(SUM(e.amount_minor) FILTER (WHERE e.status = 'paid'),0)::text AS paid_minor,
            COALESCE(SUM(e.amount_minor) FILTER (WHERE e.status IN ('approved','paid')),0)::text AS authorized_minor
     FROM expenses e
     WHERE e.organization_id = $1
       AND e.branch_id = ANY($2::uuid[])
       AND ($3::date IS NULL OR e.expense_date >= $3::date)
       AND ($4::date IS NULL OR e.expense_date <= $4::date)
     GROUP BY e.category_id, e.category_name
     ORDER BY authorized_minor DESC, e.category_name`,
    [auth.organizationId, branchIds, from, to]
  );

  const expenseBranches = await pool.query<Record<string, unknown>>(
    `SELECT e.branch_id AS id, b.name,
            COUNT(*)::text AS count,
            COALESCE(SUM(e.amount_minor) FILTER (WHERE e.status = 'submitted'),0)::text AS submitted_minor,
            COALESCE(SUM(e.amount_minor) FILTER (WHERE e.status = 'approved'),0)::text AS approved_minor,
            COALESCE(SUM(e.amount_minor) FILTER (WHERE e.status = 'paid'),0)::text AS paid_minor,
            COALESCE(SUM(e.amount_minor) FILTER (WHERE e.status IN ('approved','paid')),0)::text AS authorized_minor
     FROM expenses e
     JOIN branches b ON b.id = e.branch_id AND b.organization_id = e.organization_id
     WHERE e.organization_id = $1
       AND e.branch_id = ANY($2::uuid[])
       AND ($3::date IS NULL OR e.expense_date >= $3::date)
       AND ($4::date IS NULL OR e.expense_date <= $4::date)
     GROUP BY e.branch_id, b.name
     ORDER BY authorized_minor DESC, b.name`,
    [auth.organizationId, branchIds, from, to]
  );

  const inventory = await pool.query<Record<string, unknown>>(
    `SELECT
       COALESCE(ROUND(SUM(GREATEST(sl.on_hand_qty, 0) * sl.avg_cost_minor)),0)::bigint::text AS valuation_minor,
       COALESCE(SUM(GREATEST(sl.on_hand_qty, 0)),0)::text AS on_hand_qty,
       COUNT(*) FILTER (WHERE sl.on_hand_qty <= p.min_stock_level)::text AS low_stock_count
     FROM stock_levels sl
     JOIN products p ON p.id = sl.product_id AND p.organization_id = sl.organization_id
     WHERE sl.organization_id = $1 AND sl.branch_id = ANY($2::uuid[])`,
    [auth.organizationId, branchIds]
  );

  const receivables = await pool.query<Record<string, unknown>>(
    `SELECT COALESCE(SUM(balance),0)::text AS outstanding_minor
     FROM (
       SELECT ct.customer_id,
              SUM(CASE WHEN ct.direction = 'debit' THEN ct.amount_minor ELSE -ct.amount_minor END) AS balance
       FROM customer_credit_transactions ct
       WHERE ct.organization_id = $1 AND ct.branch_id = ANY($2::uuid[])
       GROUP BY ct.customer_id
       HAVING SUM(CASE WHEN ct.direction = 'debit' THEN ct.amount_minor ELSE -ct.amount_minor END) > 0
     ) balances`,
    [auth.organizationId, branchIds]
  );

  const payables = await pool.query<Record<string, unknown>>(
    `SELECT COALESCE(SUM(si.amount_minor - COALESCE(allocated.amount,0)),0)::text AS outstanding_minor
     FROM supplier_invoices si
     LEFT JOIN (
       SELECT organization_id, supplier_invoice_id, SUM(amount_minor) AS amount
       FROM supplier_payment_allocations
       GROUP BY organization_id, supplier_invoice_id
     ) allocated ON allocated.supplier_invoice_id = si.id AND allocated.organization_id = si.organization_id
     WHERE si.organization_id = $1
       AND si.branch_id = ANY($2::uuid[])
       AND si.status <> 'voided'`,
    [auth.organizationId, branchIds]
  );

  const drawer = await pool.query<Record<string, unknown>>(
    `SELECT
       COALESCE(SUM(CASE WHEN cm.movement_type = 'customer_payment' THEN cm.amount_minor ELSE 0 END),0)::text AS customer_collections_minor,
       COALESCE(SUM(CASE WHEN cm.movement_type = 'supplier_payment' THEN cm.amount_minor ELSE 0 END),0)::text AS supplier_payments_minor,
       COALESCE(SUM(CASE WHEN cm.movement_type = 'expense_payment' THEN cm.amount_minor ELSE 0 END),0)::text AS expense_payments_minor,
       COALESCE(SUM(CASE WHEN cm.movement_type = 'cash_in' THEN cm.amount_minor ELSE 0 END),0)::text AS cash_in_minor,
       COALESCE(SUM(CASE WHEN cm.movement_type = 'cash_out' THEN cm.amount_minor ELSE 0 END),0)::text AS cash_out_minor,
       COALESCE(SUM(CASE WHEN cm.movement_type IN ('sale_refund','sale_void') THEN cm.amount_minor ELSE 0 END),0)::text AS refunds_voids_minor,
       COALESCE(SUM(CASE WHEN cm.direction = 'in' THEN cm.amount_minor ELSE -cm.amount_minor END),0)::text AS net_movement_minor
     FROM cash_movements cm
     WHERE cm.organization_id = $1
       AND cm.branch_id = ANY($2::uuid[])
       AND ($4::date IS NULL OR (cm.created_at AT TIME ZONE $3)::date >= $4::date)
       AND ($5::date IS NULL OR (cm.created_at AT TIME ZONE $3)::date <= $5::date)`,
    [auth.organizationId, branchIds, org.timezone, from, to]
  );

  const daily = await pool.query<Record<string, unknown>>(
    `WITH sale_days AS (
       SELECT (s.sold_at AT TIME ZONE $3)::date AS day,
              SUM(s.total_minor) AS sales_minor,
              COUNT(*) AS sale_count
       FROM sales s
       WHERE s.organization_id = $1 AND s.branch_id = ANY($2::uuid[]) AND s.status <> 'voided'
         AND ($4::date IS NULL OR (s.sold_at AT TIME ZONE $3)::date >= $4::date)
         AND ($5::date IS NULL OR (s.sold_at AT TIME ZONE $3)::date <= $5::date)
       GROUP BY day
     ), expense_days AS (
       SELECT e.expense_date AS day,
              SUM(e.amount_minor) FILTER (WHERE e.status IN ('approved','paid')) AS authorized_minor,
              SUM(e.amount_minor) FILTER (WHERE e.status = 'paid') AS paid_minor
       FROM expenses e
       WHERE e.organization_id = $1 AND e.branch_id = ANY($2::uuid[])
         AND ($4::date IS NULL OR e.expense_date >= $4::date)
         AND ($5::date IS NULL OR e.expense_date <= $5::date)
       GROUP BY day
     ), days AS (
       SELECT day FROM sale_days UNION SELECT day FROM expense_days
     )
     SELECT days.day::text AS day,
            COALESCE(sale_days.sales_minor,0)::text AS sales_minor,
            COALESCE(sale_days.sale_count,0)::text AS sale_count,
            COALESCE(expense_days.authorized_minor,0)::text AS authorized_expenses_minor,
            COALESCE(expense_days.paid_minor,0)::text AS paid_expenses_minor
     FROM days
     LEFT JOIN sale_days ON sale_days.day = days.day
     LEFT JOIN expense_days ON expense_days.day = days.day
     ORDER BY days.day`,
    [auth.organizationId, branchIds, org.timezone, from, to]
  );

  const branchRows = await pool.query<Record<string, unknown>>(
    `SELECT b.id, b.name,
            COALESCE(sales.total,0)::text AS sales_minor,
            COALESCE(expenses.authorized,0)::text AS authorized_expenses_minor,
            COALESCE(expenses.paid,0)::text AS paid_expenses_minor,
            COALESCE(stock.value,0)::text AS stock_value_minor
     FROM branches b
     LEFT JOIN (
       SELECT branch_id, SUM(total_minor) AS total
       FROM sales
       WHERE organization_id = $1 AND status <> 'voided'
         AND ($4::date IS NULL OR (sold_at AT TIME ZONE $3)::date >= $4::date)
         AND ($5::date IS NULL OR (sold_at AT TIME ZONE $3)::date <= $5::date)
       GROUP BY branch_id
     ) sales ON sales.branch_id = b.id
     LEFT JOIN (
       SELECT branch_id,
              SUM(amount_minor) FILTER (WHERE status IN ('approved','paid')) AS authorized,
              SUM(amount_minor) FILTER (WHERE status = 'paid') AS paid
       FROM expenses
       WHERE organization_id = $1
         AND ($4::date IS NULL OR expense_date >= $4::date)
         AND ($5::date IS NULL OR expense_date <= $5::date)
       GROUP BY branch_id
     ) expenses ON expenses.branch_id = b.id
     LEFT JOIN (
       SELECT branch_id, ROUND(SUM(GREATEST(on_hand_qty,0) * avg_cost_minor))::bigint AS value
       FROM stock_levels
       WHERE organization_id = $1
       GROUP BY branch_id
     ) stock ON stock.branch_id = b.id
     WHERE b.organization_id = $1 AND b.id = ANY($2::uuid[])
     ORDER BY b.name`,
    [auth.organizationId, branchIds, org.timezone, from, to]
  );

  const productSales = await pool.query<Record<string, unknown>>(
    `SELECT i.product_id, i.product_sku, i.product_name, i.unit_code,
            SUM(i.quantity)::text AS quantity, SUM(i.total_minor)::text AS sales_minor,
            SUM(i.tax_minor)::text AS tax_minor, SUM(i.cost_total_minor)::text AS cost_minor
     FROM sale_items i JOIN sales s ON s.id = i.sale_id AND s.organization_id = i.organization_id
     WHERE s.organization_id = $1 AND s.branch_id = ANY($2::uuid[]) AND s.status <> 'voided'
       AND ($4::date IS NULL OR (s.sold_at AT TIME ZONE $3)::date >= $4::date)
       AND ($5::date IS NULL OR (s.sold_at AT TIME ZONE $3)::date <= $5::date)
     GROUP BY i.product_id, i.product_sku, i.product_name, i.unit_code
     ORDER BY SUM(i.total_minor) DESC, i.product_sku LIMIT 20`,
    [auth.organizationId, branchIds, org.timezone, from, to]
  );
  const cashierSales = await pool.query<Record<string, unknown>>(
    `SELECT s.cashier_membership_id, u.display_name, COUNT(*)::text AS sale_count,
            SUM(s.total_minor)::text AS sales_minor
     FROM sales s JOIN memberships m ON m.id = s.cashier_membership_id AND m.organization_id = s.organization_id
     JOIN users u ON u.id = m.user_id
     WHERE s.organization_id = $1 AND s.branch_id = ANY($2::uuid[]) AND s.status <> 'voided'
       AND ($4::date IS NULL OR (s.sold_at AT TIME ZONE $3)::date >= $4::date)
       AND ($5::date IS NULL OR (s.sold_at AT TIME ZONE $3)::date <= $5::date)
     GROUP BY s.cashier_membership_id, u.display_name ORDER BY SUM(s.total_minor) DESC, s.cashier_membership_id`,
    [auth.organizationId, branchIds, org.timezone, from, to]
  );

  const sale = sales.rows[0]!;
  const expense = expenseSummary.rows[0]!;
  const inventoryRow = inventory.rows[0]!;
  const drawerRow = drawer.rows[0]!;
  const grossProfit = BigInt(String(sale.gross_sales_minor)) - BigInt(String(sale.tax_minor)) - BigInt(String(sale.cost_minor));

  return {
    generatedAt: new Date().toISOString(),
    organizationName: org.display_name,
    currencyCode: org.currency_code,
    timezone: org.timezone,
    range: { from, to, branchId: query.branchId ?? null },
    topProducts: productSales.rows.map((row) => ({
      productId: row.product_id, sku: row.product_sku, name: row.product_name, unitCode: row.unit_code,
      quantity: String(row.quantity), sales: minor(row, 'sales_minor'),
      grossProfit: minorUnitsToDecimal(BigInt(String(row.sales_minor)) - BigInt(String(row.tax_minor)) - BigInt(String(row.cost_minor)))
    })),
    cashiers: cashierSales.rows.map((row) => ({ membershipId: row.cashier_membership_id, name: row.display_name, saleCount: Number(row.sale_count), sales: minor(row, 'sales_minor') })),
    sales: {
      count: Number(sale.sale_count),
      grossSales: minor(sale, 'gross_sales_minor'),
      discounts: minor(sale, 'discounts_minor'),
      tax: minor(sale, 'tax_minor'),
      costOfGoodsSold: minor(sale, 'cost_minor'),
      grossProfit: minorUnitsToDecimal(grossProfit),
      cashSales: minor(sale, 'cash_sales_minor'),
      creditSales: minor(sale, 'credit_sales_minor'),
      mpesaSales: minor(sale, 'mpesa_sales_minor'),
      cardSales: minor(sale, 'card_sales_minor'),
      testSales: minor(sale, 'test_sales_minor'),
      returned: minor(sale, 'returned_minor'),
      refunded: minor(sale, 'refunded_minor')
    },
    expenses: {
      count: Number(expense.expense_count),
      draft: minor(expense, 'draft_minor'),
      submitted: minor(expense, 'submitted_minor'),
      approved: minor(expense, 'approved_minor'),
      pendingPayment: minor(expense, 'pending_minor'),
      paid: minor(expense, 'paid_minor'),
      authorized: minor(expense, 'authorized_minor'),
      categories: expenseCategories.rows.map(mapBreakdown),
      branches: expenseBranches.rows.map(mapBreakdown)
    },
    inventory: {
      stockValue: minor(inventoryRow, 'valuation_minor'),
      onHandQty: String(inventoryRow.on_hand_qty ?? '0'),
      lowStockCount: Number(inventoryRow.low_stock_count)
    },
    debt: {
      receivablesOutstanding: minor(receivables.rows[0]!, 'outstanding_minor'),
      payablesOutstanding: minor(payables.rows[0]!, 'outstanding_minor')
    },
    drawer: {
      cashSales: minor(sale, 'cash_sales_minor'),
      customerCollections: minor(drawerRow, 'customer_collections_minor'),
      supplierPayments: minor(drawerRow, 'supplier_payments_minor'),
      expensePayments: minor(drawerRow, 'expense_payments_minor'),
      cashIn: minor(drawerRow, 'cash_in_minor'),
      cashOut: minor(drawerRow, 'cash_out_minor'),
      refundsAndVoids: minor(drawerRow, 'refunds_voids_minor'),
      netCashMovement: minor(drawerRow, 'net_movement_minor')
    },
    daily: daily.rows.map((row) => ({
      date: row.day,
      sales: minor(row, 'sales_minor'),
      saleCount: Number(row.sale_count),
      authorizedExpenses: minor(row, 'authorized_expenses_minor'),
      paidExpenses: minor(row, 'paid_expenses_minor')
    })),
    branches: branchRows.rows.map((row) => ({
      branchId: row.id,
      name: row.name,
      sales: minor(row, 'sales_minor'),
      authorizedExpenses: minor(row, 'authorized_expenses_minor'),
      paidExpenses: minor(row, 'paid_expenses_minor'),
      stockValue: minor(row, 'stock_value_minor')
    }))
  };
}

export async function exportOperationsReportCsv(pool: pg.Pool, auth: AuthContext, query: OperationsReportQuery) {
  const report = await getOperationsReport(pool, auth, query);
  const lines = [
    ['Organization', report.organizationName],
    ['Generated at', report.generatedAt],
    ['Timezone', report.timezone],
    ['From', report.range.from ?? 'All dates'],
    ['To', report.range.to ?? 'All dates'],
    ['Branch scope', report.branches.map((branch) => branch.name).join('; ')],
    [],
    ['Metric', 'Value', 'Currency'],
    ['Sales count', report.sales.count, ''],
    ['Gross sales', report.sales.grossSales, report.currencyCode],
    ['Cash sales', report.sales.cashSales, report.currencyCode],
    ['Credit sales', report.sales.creditSales, report.currencyCode],
      ['M-Pesa sales', report.sales.mpesaSales, report.currencyCode],
      ['Card sales', report.sales.cardSales, report.currencyCode],
      ['Included simulated/sandbox sales (no money moved)', report.sales.testSales, report.currencyCode],
    ['Discounts', report.sales.discounts, report.currencyCode],
    ['Tax', report.sales.tax, report.currencyCode],
    ['Cost of goods sold', report.sales.costOfGoodsSold, report.currencyCode],
    ['Gross profit', report.sales.grossProfit, report.currencyCode],
    ['Returned value', report.sales.returned, report.currencyCode],
    ['Refunded cash', report.sales.refunded, report.currencyCode],
    ['Expense count', report.expenses.count, ''],
    ['Draft expenses', report.expenses.draft, report.currencyCode],
    ['Submitted expenses', report.expenses.submitted, report.currencyCode],
    ['Approved expenses', report.expenses.approved, report.currencyCode],
    ['Pending expense payments', report.expenses.pendingPayment, report.currencyCode],
    ['Paid expenses', report.expenses.paid, report.currencyCode],
    ['Authorized expenses', report.expenses.authorized, report.currencyCode],
    ['Stock on hand', report.inventory.onHandQty, 'base units'],
    ['Stock value', report.inventory.stockValue, report.currencyCode],
    ['Low-stock lines', report.inventory.lowStockCount, ''],
    ['Customer receivables', report.debt.receivablesOutstanding, report.currencyCode],
    ['Supplier payables', report.debt.payablesOutstanding, report.currencyCode],
    ['Cash sale receipts', report.drawer.cashSales, report.currencyCode],
    ['Customer collections', report.drawer.customerCollections, report.currencyCode],
    ['Supplier payments', report.drawer.supplierPayments, report.currencyCode],
    ['Expense payments', report.drawer.expensePayments, report.currencyCode],
    ['Manual cash in', report.drawer.cashIn, report.currencyCode],
    ['Manual cash out', report.drawer.cashOut, report.currencyCode],
    ['Refunds and voids', report.drawer.refundsAndVoids, report.currencyCode],
    ['Net cash movement', report.drawer.netCashMovement, report.currencyCode],
    [],
    ['Daily report', 'Sales', 'Transactions', 'Authorized expenses', 'Paid expenses'],
    ...report.daily.map((row) => [row.date, row.sales, row.saleCount, row.authorizedExpenses, row.paidExpenses]),
    [],
    ['Expense category', 'Count', 'Submitted', 'Approved', 'Paid', 'Authorized'],
    ...report.expenses.categories.map((row) => [row.name, row.count, row.submitted, row.approved, row.paid, row.total]),
    [],
    ['Branch', 'Sales', 'Authorized expenses', 'Paid expenses', 'Stock value'],
    ...report.branches.map((row) => [row.name, row.sales, row.authorizedExpenses, row.paidExpenses, row.stockValue]),
    [],
    ['Top 20 products before returns', 'SKU', 'Unit', 'Quantity', 'Gross sales', 'Gross profit excluding tax before returns'],
    ...report.topProducts.map((row) => [row.name, row.sku, unitLabel(String(row.unitCode ?? '')), row.quantity, row.sales, row.grossProfit]),
    [],
    ['Cashier', 'Transactions', 'Gross sales before returns'],
    ...report.cashiers.map((row) => [row.name, row.saleCount, row.sales])
  ];
  return `\uFEFF${lines.map((line) => line.map(csvCell).join(',')).join('\r\n')}`;
}
