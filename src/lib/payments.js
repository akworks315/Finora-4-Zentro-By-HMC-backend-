// Pure payment helpers (no database), so the rules are easy to test.
export const money2 = n => Math.round((Number(n) || 0) * 100) / 100;

export const sumPayments = payments => money2((payments || []).reduce((a, p) => a + (Number(p.amount) || 0), 0));

// Works out paidAmount / status / paidAt from the list of payments.
// Cancelled invoices keep their status. Pending and Partial are stored; Overdue is derived by the frontend from the due date.
export function settle(sale) {
  const paid = sumPayments(sale.payments);
  sale.paidAmount = paid;
  if (sale.status === "Cancelled") return sale;
  if (sale.amount > 0 && paid >= money2(sale.amount)) {
    sale.status = "Paid";
    const last = (sale.payments || []).map(p => new Date(p.date || Date.now()).getTime()).filter(Number.isFinite).sort((a, b) => b - a)[0];
    sale.paidAt = new Date(last || Date.now());
  } else {
    sale.status = paid > 0 ? "Partial" : "Pending";
    sale.paidAt = undefined;
  }
  return sale;
}

export const balanceOf = sale => Math.max(0, money2(money2(sale.amount) - sumPayments(sale.payments)));
