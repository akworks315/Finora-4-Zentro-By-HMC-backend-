import { Router } from "express";
import { Sale, Expense, Budget, Settings, Work, Payable, CATEGORIES, PAYEE_TYPES } from "../models/index.js";
import { asyncRoute, clean, toDate, escapeRegex } from "../lib/util.js";
import { money2, settle, balanceOf } from "../lib/payments.js";
import { notifyCustomer, notifyPayee } from "../lib/notify.js";

export const API_VERSION = "4.0.0"; // frontend checks this to detect an outdated deployment
const router = Router();
const STATUSES = ["Paid", "Partial", "Pending", "Overdue", "Cancelled"];
const METHODS = ["Cash", "Bank Transfer", "Card", "Online", "Cheque", "Not recorded"];

// Next invoice number: INV-1001, INV-1002, ...
async function nextInvoiceNumber() {
  const last = await Sale.findOne({ reference: /^INV-\d{4,6}$/ }).sort({ reference: -1 }).select("reference").lean();
  const n = last ? Number(last.reference.slice(4)) + 1 : 1001;
  return `INV-${n}`;
}

// Builds a clean sale document from request data. Returns { doc } or { error }.
function buildSale(input, { partial = false } = {}) {
  const doc = {};
  const has = key => input[key] !== undefined;

  if (!partial || has("customer")) doc.customer = clean(input.customer ?? input.customerName);
  if (!partial || has("service")) doc.service = clean(input.service ?? input.itemName);
  if (!partial || has("amount")) doc.amount = Number(input.amount ?? input.total);
  if (has("customerEmail")) doc.customerEmail = clean(input.customerEmail);
  if (has("house")) doc.house = clean(input.house);
  if (has("address")) doc.address = clean(input.address);
  if (has("customerPhone")) {
    doc.customerPhone = clean(input.customerPhone);
    const digits = doc.customerPhone.replace(/\D/g, "");
    if (doc.customerPhone && (!/^[+\d][\d\s\-()]*$/.test(doc.customerPhone) || digits.length < 7 || digits.length > 15)) return { error: "WhatsApp number must be 7 to 15 digits, e.g. 0300 1234567 or +92 300 1234567." };
  }
  if (has("date")) doc.date = toDate(input.date) || new Date();
  if (has("dueDate")) doc.dueDate = toDate(input.dueDate) || null;
  if (has("status")) {
    if (!STATUSES.includes(input.status)) return { error: "Status must be Paid, Partial, Pending, Overdue or Cancelled." };
    doc.status = input.status;
  }
  if (has("paidAt")) doc.paidAt = toDate(input.paidAt) || null;
  if (has("method") || has("paymentMethod")) doc.method = clean(input.method ?? input.paymentMethod) || "Not recorded";
  if (has("currency")) doc.currency = clean(input.currency) || "PKR";
  if (has("notes")) doc.notes = clean(input.notes);

  if (!partial || has("customer") || has("customerName")) {
    if (!doc.customer) return { error: "Customer name is required." };
  }
  if (!partial || has("service") || has("itemName")) {
    if (!doc.service) return { error: "Service is required." };
  }
  if (!partial || has("amount") || has("total")) {
    if (!Number.isFinite(doc.amount) || doc.amount < 0) return { error: "Amount must be a number, zero or more." };
  }
  return { doc };
}

router.get("/health", (req, res) =>
  res.json({ ok: true, database: req.app.locals.dbReady ? "connected" : "disconnected", service: "Finora API", version: API_VERSION, ...(req.app.locals.dbReady ? {} : { reason: req.app.locals.dbError || "unknown" }) })
);

// Old invoices were marked "Paid" without a payment list. Turn that into one full payment before any change.
function materializeLegacy(sale) {
  if (sale.status === "Paid" && sale.payments.length === 0 && sale.amount > 0) {
    sale.payments.push({ amount: sale.amount, date: sale.paidAt || sale.date || new Date(), method: sale.method && sale.method !== "Not recorded" ? sale.method : "Cash" });
  }
}

// Money already received when a sale is created: the whole amount if status is Paid, or "paidNow" for a part payment.
function initialPayments(input, doc) {
  let paid = input.status === "Paid" ? doc.amount : Number(input.paidNow ?? input.paidAmount ?? 0);
  if (!Number.isFinite(paid) || paid < 0) return { error: "Amount received must be zero or more." };
  if (paid > doc.amount) return { error: "Amount received cannot be more than the invoice amount." };
  paid = money2(paid);
  const method = doc.method && doc.method !== "Not recorded" ? doc.method : "Cash";
  return { payments: paid > 0 ? [{ amount: paid, date: doc.date || new Date(), method }] : [] };
}

async function createSale(input, reference) {
  const { doc, error } = buildSale(input || {});
  if (error) return { error };
  const init = initialPayments(input, doc);
  if (init.error) return { error: init.error };
  doc.status = input.status === "Cancelled" ? "Cancelled" : "Pending";
  delete doc.paidAt;
  if (!doc.date) doc.date = new Date();
  const sale = new Sale({ ...doc, payments: init.payments, reference });
  settle(sale);
  await sale.save();
  return { sale };
}

// Service-provider webhook: POST /api/integrations/sales with the x-sync-key header.
router.post("/integrations/sales", asyncRoute(async (req, res) => {
  const expected = process.env.SYNC_API_KEY;
  if (!expected || req.get("x-sync-key") !== expected) return res.status(401).json({ message: "Invalid sync key." });
  const incoming = Array.isArray(req.body) ? req.body : [req.body];
  const saved = [];
  for (const item of incoming) {
    const { sale, error } = await createSale(item || {}, clean(item?.reference) || (await nextInvoiceNumber()));
    if (error) return res.status(400).json({ message: error, received: saved.length });
    saved.push(sale);
  }
  res.status(201).json({ received: saved.length, records: saved.map(x => x.toJSON()) });
}));

// List all sales (newest first)
router.get("/sales", asyncRoute(async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 1000, 5000);
  const docs = await Sale.find().sort({ date: -1, createdAt: -1 }).limit(limit);
  res.json(docs.map(d => d.toJSON()));
}));

// Create a sale / invoice. Optional: paidNow (part payment received at creation).
router.post("/sales", asyncRoute(async (req, res) => {
  // Retry if two invoices are created at the same moment and get the same number.
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const { sale, error } = await createSale(req.body, clean(req.body?.reference) || (await nextInvoiceNumber()));
      if (error) return res.status(400).json({ message: error });
      return res.status(201).json(sale.toJSON());
    } catch (err) {
      if (err.code !== 11000 || req.body?.reference) throw err;
    }
  }
  res.status(409).json({ message: "Could not generate a unique invoice number. Please try again." });
}));

const dayText = d => (d ? new Date(d).toISOString().slice(0, 10) : "none");

// Update a sale — :id is the invoice number. Status follows the payments; asking for "Paid" records the remaining balance as a payment.
// Returns the sale plus `notification` (the WhatsApp message that was sent, or ready to send) when the customer should hear about the change.
router.patch("/sales/:id", asyncRoute(async (req, res) => {
  const { doc, error } = buildSale(req.body || {}, { partial: true });
  if (error) return res.status(400).json({ message: error });
  const sale = await Sale.findOne({ reference: req.params.id });
  if (!sale) return res.status(404).json({ message: "Invoice not found." });
  materializeLegacy(sale);
  const before = { amount: sale.amount, dueDate: dayText(sale.dueDate), service: sale.service, status: sale.status };

  const want = doc.status; delete doc.status; delete doc.paidAt;
  Object.assign(sale, doc);
  if (want && want !== "Cancelled" && sale.status === "Cancelled") sale.status = "Pending";
  let added = 0;
  if (want === "Cancelled") sale.status = "Cancelled";
  else if (want === "Paid") {
    added = balanceOf(sale);
    if (added > 0) sale.payments.push({ amount: added, date: new Date(), method: doc.method && doc.method !== "Not recorded" ? doc.method : "Bank Transfer" });
  } else if (want === "Pending") sale.payments = [];
  settle(sale);
  await sale.save();

  const changes = [];
  if (sale.amount !== before.amount) changes.push(`Amount changed: ${Math.round(before.amount).toLocaleString("en-US")} to ${Math.round(sale.amount).toLocaleString("en-US")}`);
  if (dayText(sale.dueDate) !== before.dueDate) changes.push(`New due date: ${dayText(sale.dueDate)}`);
  if (sale.service !== before.service) changes.push(`Service: ${sale.service}`);
  let notification = null;
  if (added > 0) notification = await notifyCustomer("payment", sale, { amount: added });
  else if (want === "Cancelled" && before.status !== "Cancelled") notification = await notifyCustomer("cancelled", sale);
  else if (changes.length) notification = await notifyCustomer("updated", sale, { changes });
  res.json({ ...sale.toJSON(), notification });
}));

// Record a (part) payment: POST /api/sales/INV-1001/payments { amount, method?, date?, note? }
router.post("/sales/:id/payments", asyncRoute(async (req, res) => {
  const amount = money2(req.body?.amount);
  if (!(amount > 0)) return res.status(400).json({ message: "Payment amount must be greater than zero." });
  const sale = await Sale.findOne({ reference: req.params.id });
  if (!sale) return res.status(404).json({ message: "Invoice not found." });
  if (sale.status === "Cancelled") return res.status(400).json({ message: "A cancelled invoice cannot take payments." });
  materializeLegacy(sale);
  const left = balanceOf(sale);
  if (left <= 0) return res.status(400).json({ message: "This invoice is already paid in full." });
  if (amount > left + 0.001) return res.status(400).json({ message: `Payment is more than the remaining balance (${left}).` });
  const method = METHODS.includes(req.body?.method) ? req.body.method : "Cash";
  sale.payments.push({ amount, date: toDate(req.body?.date) || new Date(), method, note: clean(req.body?.note) });
  sale.method = method;
  settle(sale);
  await sale.save();
  const notification = await notifyCustomer("payment", sale, { amount });
  res.status(201).json({ ...sale.toJSON(), notification });
}));

// Remove a wrongly entered payment.
router.delete("/sales/:id/payments/:pid", asyncRoute(async (req, res) => {
  const sale = await Sale.findOne({ reference: req.params.id });
  if (!sale) return res.status(404).json({ message: "Invoice not found." });
  materializeLegacy(sale);
  const p = req.params.pid === "full" ? sale.payments[0] : sale.payments.id(req.params.pid);
  if (!p) return res.status(404).json({ message: "Payment not found." });
  sale.payments.pull(p._id);
  settle(sale);
  await sale.save();
  const notification = await notifyCustomer("payment-removed", sale);
  res.json({ ...sale.toJSON(), notification });
}));

router.delete("/sales/:id", asyncRoute(async (req, res) => {
  const sale = await Sale.findOneAndDelete({ reference: req.params.id });
  if (!sale) return res.status(404).json({ message: "Invoice not found." });
  res.json({ deleted: req.params.id });
}));

// ---------- Expenses & monthly budgets ----------
function buildExpense(input, { partial = false } = {}) {
  const doc = {};
  const has = k => input[k] !== undefined;
  if (!partial || has("title")) { doc.title = clean(input.title); if (!doc.title) return { error: "Title is required." }; }
  if (has("payee")) doc.payee = clean(input.payee);
  if (has("payeeType")) { if (!PAYEE_TYPES.includes(input.payeeType)) return { error: "Unknown person type." }; doc.payeeType = input.payeeType; }
  if (!partial || has("amount")) { doc.amount = Number(input.amount); if (!Number.isFinite(doc.amount) || doc.amount <= 0) return { error: "Amount must be greater than zero." }; }
  if (has("category")) { if (!CATEGORIES.includes(input.category)) return { error: "Unknown category." }; doc.category = input.category; }
  if (has("date")) doc.date = toDate(input.date) || new Date();
  if (has("method")) doc.method = clean(input.method) || "Cash";
  if (has("notes")) doc.notes = clean(input.notes);
  return { doc };
}

router.get("/expenses", asyncRoute(async (req, res) => {
  const q = {};
  const from = toDate(req.query.from), to = toDate(req.query.to);
  if (from || to) q.date = { ...(from && { $gte: from }), ...(to && { $lte: to }) };
  // ?q=ali searches the person (employee / seller), title, category and notes. ?payee=Ali matches one person exactly.
  const text = clean(req.query.q).slice(0, 80);
  if (text) { const rx = new RegExp(escapeRegex(text), "i"); q.$or = [{ payee: rx }, { title: rx }, { category: rx }, { notes: rx }]; }
  if (clean(req.query.payee)) q.payee = new RegExp(`^${escapeRegex(clean(req.query.payee))}$`, "i");
  res.json((await Expense.find(q).sort({ date: -1 }).limit(2000)).map(d => d.toJSON()));
}));
router.post("/expenses", asyncRoute(async (req, res) => {
  const { doc, error } = buildExpense(req.body || {});
  if (error) return res.status(400).json({ message: error });
  res.status(201).json((await Expense.create(doc)).toJSON());
}));
router.delete("/expenses/:id", asyncRoute(async (req, res) => {
  if (!/^[a-f\d]{24}$/i.test(req.params.id)) return res.status(404).json({ message: "Expense not found." });
  const e = await Expense.findByIdAndDelete(req.params.id);
  if (!e) return res.status(404).json({ message: "Expense not found." });
  res.json({ deleted: req.params.id });
}));

router.get("/budgets", asyncRoute(async (_req, res) => res.json((await Budget.find().sort({ category: 1 })).map(b => b.toJSON()))));
router.put("/budgets/:category", asyncRoute(async (req, res) => {
  if (!CATEGORIES.includes(req.params.category)) return res.status(400).json({ message: "Unknown category." });
  const limit = Number(req.body?.limit);
  if (!Number.isFinite(limit) || limit < 0) return res.status(400).json({ message: "Limit must be zero or more." });
  const b = await Budget.findOneAndUpdate({ category: req.params.category }, { $set: { limit } }, { upsert: true, new: true, runValidators: true });
  res.json(b.toJSON());
}));

// ---------- Bills to pay (money you owe to employees / sellers), with part payments ----------
const isId = id => /^[a-f\d]{24}$/i.test(id);
function buildBill(input, { partial = false } = {}) {
  const doc = {};
  const has = k => input[k] !== undefined;
  if (!partial || has("payee")) { doc.payee = clean(input.payee); if (!doc.payee) return { error: "Enter the name of the person you are paying." }; }
  if (!partial || has("title")) { doc.title = clean(input.title); if (!doc.title) return { error: "Enter what the payment is for." }; }
  if (!partial || has("amount")) { doc.amount = Number(input.amount); if (!Number.isFinite(doc.amount) || doc.amount <= 0) return { error: "Amount must be greater than zero." }; }
  if (has("payeePhone")) {
    doc.payeePhone = clean(input.payeePhone);
    const digits = doc.payeePhone.replace(/\D/g, "");
    if (doc.payeePhone && (!/^[+\d][\d\s\-()]*$/.test(doc.payeePhone) || digits.length < 7 || digits.length > 15)) return { error: "WhatsApp number must be 7 to 15 digits, e.g. 0300 1234567." };
  }
  if (has("payeeType")) { if (!PAYEE_TYPES.includes(input.payeeType)) return { error: "Unknown person type." }; doc.payeeType = input.payeeType; }
  if (has("category")) { if (!CATEGORIES.includes(input.category)) return { error: "Unknown category." }; doc.category = input.category; }
  if (has("date")) doc.date = toDate(input.date) || new Date();
  if (has("dueDate")) doc.dueDate = toDate(input.dueDate) || null;
  if (has("method")) doc.method = clean(input.method) || "Not recorded";
  if (has("notes")) doc.notes = clean(input.notes);
  if (has("status") && !["Paid", "Partial", "Pending", "Cancelled", "Overdue"].includes(input.status)) return { error: "Unknown status." };
  return { doc };
}

router.get("/payables", asyncRoute(async (req, res) => {
  const q = {};
  const text = clean(req.query.q).slice(0, 80);
  if (text) { const rx = new RegExp(escapeRegex(text), "i"); q.$or = [{ payee: rx }, { title: rx }, { category: rx }]; }
  res.json((await Payable.find(q).sort({ date: -1, createdAt: -1 }).limit(2000)).map(b => b.toJSON()));
}));

router.post("/payables", asyncRoute(async (req, res) => {
  const { doc, error } = buildBill(req.body || {});
  if (error) return res.status(400).json({ message: error });
  let paid = Number(req.body?.paidNow ?? 0);
  if (!Number.isFinite(paid) || paid < 0) return res.status(400).json({ message: "Amount paid must be zero or more." });
  if (paid > doc.amount) return res.status(400).json({ message: "Amount paid cannot be more than the total." });
  paid = money2(paid);
  const method = METHODS.includes(doc.method) && doc.method !== "Not recorded" ? doc.method : "Cash";
  const bill = new Payable({ ...doc, status: "Pending", date: doc.date || new Date(), payments: paid > 0 ? [{ amount: paid, date: doc.date || new Date(), method }] : [] });
  settle(bill);
  await bill.save();
  res.status(201).json(bill.toJSON());
}));

// Update a bill. Asking for "Paid" records the remaining balance as a payment. Returns `notification` when the person should hear about it.
router.patch("/payables/:id", asyncRoute(async (req, res) => {
  if (!isId(req.params.id)) return res.status(404).json({ message: "Bill not found." });
  const { doc, error } = buildBill(req.body || {}, { partial: true });
  if (error) return res.status(400).json({ message: error });
  const bill = await Payable.findById(req.params.id);
  if (!bill) return res.status(404).json({ message: "Bill not found." });
  const before = { amount: bill.amount, dueDate: dayText(bill.dueDate), title: bill.title, status: bill.status };
  const want = req.body?.status; delete doc.status;
  Object.assign(bill, doc);
  if (want && want !== "Cancelled" && bill.status === "Cancelled") bill.status = "Pending";
  let added = 0;
  if (want === "Cancelled") bill.status = "Cancelled";
  else if (want === "Paid") {
    added = balanceOf(bill);
    if (added > 0) bill.payments.push({ amount: added, date: new Date(), method: METHODS.includes(doc.method) && doc.method !== "Not recorded" ? doc.method : "Cash" });
  }
  settle(bill);
  await bill.save();
  const changes = [];
  if (bill.amount !== before.amount) changes.push(`Total changed: ${Math.round(before.amount).toLocaleString("en-US")} to ${Math.round(bill.amount).toLocaleString("en-US")}`);
  if (dayText(bill.dueDate) !== before.dueDate) changes.push(`New due date: ${dayText(bill.dueDate)}`);
  let notification = null;
  if (added > 0) notification = await notifyPayee("payment", bill, { amount: added });
  else if (want === "Cancelled" && before.status !== "Cancelled") notification = await notifyPayee("cancelled", bill);
  else if (changes.length) notification = await notifyPayee("updated", bill, { changes });
  res.json({ ...bill.toJSON(), notification });
}));

router.post("/payables/:id/payments", asyncRoute(async (req, res) => {
  if (!isId(req.params.id)) return res.status(404).json({ message: "Bill not found." });
  const amount = money2(req.body?.amount);
  if (!(amount > 0)) return res.status(400).json({ message: "Payment amount must be greater than zero." });
  const bill = await Payable.findById(req.params.id);
  if (!bill) return res.status(404).json({ message: "Bill not found." });
  if (bill.status === "Cancelled") return res.status(400).json({ message: "A cancelled bill cannot take payments." });
  const left = balanceOf(bill);
  if (left <= 0) return res.status(400).json({ message: "This bill is already paid in full." });
  if (amount > left + 0.001) return res.status(400).json({ message: `Payment is more than the remaining balance (${left}).` });
  const method = METHODS.includes(req.body?.method) ? req.body.method : "Cash";
  bill.payments.push({ amount, date: toDate(req.body?.date) || new Date(), method, note: clean(req.body?.note) });
  bill.method = method;
  settle(bill);
  await bill.save();
  const notification = await notifyPayee("payment", bill, { amount });
  res.status(201).json({ ...bill.toJSON(), notification });
}));

router.delete("/payables/:id/payments/:pid", asyncRoute(async (req, res) => {
  if (!isId(req.params.id)) return res.status(404).json({ message: "Bill not found." });
  const bill = await Payable.findById(req.params.id);
  if (!bill) return res.status(404).json({ message: "Bill not found." });
  const p = bill.payments.id(req.params.pid);
  if (!p) return res.status(404).json({ message: "Payment not found." });
  bill.payments.pull(p._id);
  settle(bill);
  await bill.save();
  const notification = await notifyPayee("payment-removed", bill);
  res.json({ ...bill.toJSON(), notification });
}));

router.delete("/payables/:id", asyncRoute(async (req, res) => {
  if (!isId(req.params.id)) return res.status(404).json({ message: "Bill not found." });
  const b = await Payable.findByIdAndDelete(req.params.id);
  if (!b) return res.status(404).json({ message: "Bill not found." });
  res.json({ deleted: req.params.id });
}));

// ---------- Construction work (area x rate) and working permissions ----------
function buildWork(input, { partial = false } = {}) {
  const doc = {};
  const has = k => input[k] !== undefined;
  if (!partial || has("employee")) { doc.employee = clean(input.employee); if (!doc.employee) return { error: "Employee name is required." }; }
  if (!partial || has("site")) { doc.site = clean(input.site); if (!doc.site) return { error: "Area / site is required." }; }
  if (!partial || has("areaSqft")) { doc.areaSqft = Number(input.areaSqft); if (!Number.isFinite(doc.areaSqft) || doc.areaSqft <= 0) return { error: "Area (sq ft) must be greater than zero." }; }
  if (!partial || has("ratePerSqft")) { doc.ratePerSqft = Number(input.ratePerSqft); if (!Number.isFinite(doc.ratePerSqft) || doc.ratePerSqft <= 0) return { error: "Rate per sq ft must be greater than zero." }; }
  if (has("employeePhone")) doc.employeePhone = clean(input.employeePhone);
  if (has("status")) { if (!["Active", "Completed", "Cancelled"].includes(input.status)) return { error: "Status must be Active, Completed or Cancelled." }; doc.status = input.status; }
  if (has("startedOn")) doc.startedOn = toDate(input.startedOn) || null;
  if (has("permitNo")) doc.permitNo = clean(input.permitNo);
  if (has("permitAuthority")) doc.permitAuthority = clean(input.permitAuthority);
  if (has("permitStart")) doc.permitStart = toDate(input.permitStart) || null;
  if (has("permitDue")) doc.permitDue = toDate(input.permitDue) || null;
  if (has("notes")) doc.notes = clean(input.notes);
  if (doc.permitStart && doc.permitDue && doc.permitDue < doc.permitStart) return { error: "Permission due date cannot be before its start date." };
  return { doc };
}

router.get("/works", asyncRoute(async (req, res) => {
  const q = {};
  const text = clean(req.query.q).slice(0, 80);
  if (text) { const rx = new RegExp(escapeRegex(text), "i"); q.$or = [{ employee: rx }, { site: rx }, { permitNo: rx }]; }
  res.json((await Work.find(q).sort({ permitDue: 1, createdAt: -1 }).limit(2000)).map(w => w.toJSON()));
}));
router.post("/works", asyncRoute(async (req, res) => {
  const { doc, error } = buildWork(req.body || {});
  if (error) return res.status(400).json({ message: error });
  doc.amount = money2(doc.areaSqft * doc.ratePerSqft);
  res.status(201).json((await Work.create(doc)).toJSON());
}));
router.patch("/works/:id", asyncRoute(async (req, res) => {
  if (!/^[a-f\d]{24}$/i.test(req.params.id)) return res.status(404).json({ message: "Work not found." });
  const { doc, error } = buildWork(req.body || {}, { partial: true });
  if (error) return res.status(400).json({ message: error });
  const work = await Work.findById(req.params.id);
  if (!work) return res.status(404).json({ message: "Work not found." });
  Object.assign(work, doc);
  if (work.permitStart && work.permitDue && work.permitDue < work.permitStart) return res.status(400).json({ message: "Permission due date cannot be before its start date." });
  work.amount = money2(work.areaSqft * work.ratePerSqft);
  await work.save();
  res.json(work.toJSON());
}));
// Renew the working permission: the old period is kept in permitHistory, the new dates become current.
router.post("/works/:id/renew", asyncRoute(async (req, res) => {
  if (!/^[a-f\d]{24}$/i.test(req.params.id)) return res.status(404).json({ message: "Work not found." });
  const start = toDate(req.body?.permitStart), due = toDate(req.body?.permitDue);
  if (!due) return res.status(400).json({ message: "Enter the new permission due date." });
  if (start && due < start) return res.status(400).json({ message: "Permission due date cannot be before its start date." });
  const work = await Work.findById(req.params.id);
  if (!work) return res.status(404).json({ message: "Work not found." });
  if (work.permitDue || work.permitStart || work.permitNo) work.permitHistory.push({ permitNo: work.permitNo, permitStart: work.permitStart, permitDue: work.permitDue, note: clean(req.body?.note) });
  work.permitStart = start || new Date();
  work.permitDue = due;
  if (req.body?.permitNo !== undefined) work.permitNo = clean(req.body.permitNo);
  if (req.body?.permitAuthority !== undefined) work.permitAuthority = clean(req.body.permitAuthority);
  await work.save();
  res.json(work.toJSON());
}));
router.delete("/works/:id", asyncRoute(async (req, res) => {
  if (!/^[a-f\d]{24}$/i.test(req.params.id)) return res.status(404).json({ message: "Work not found." });
  const w = await Work.findByIdAndDelete(req.params.id);
  if (!w) return res.status(404).json({ message: "Work not found." });
  res.json({ deleted: req.params.id });
}));

// ---------- Business settings (stored in the database) ----------
router.get("/settings", asyncRoute(async (_req, res) => {
  const s = await Settings.findOneAndUpdate({ key: "main" }, { $setOnInsert: { key: "main" } }, { upsert: true, new: true });
  res.json({ businessName: s.businessName, portfolio: s.portfolio });
}));
router.put("/settings", asyncRoute(async (req, res) => {
  const set = {};
  if (req.body?.businessName !== undefined) { set.businessName = clean(req.body.businessName); if (!set.businessName) return res.status(400).json({ message: "Business name cannot be empty." }); }
  if (req.body?.portfolio !== undefined) {
    const url = clean(req.body.portfolio);
    if (url && !/^https?:\/\//i.test(url)) return res.status(400).json({ message: "Portfolio link must start with http:// or https://" });
    set.portfolio = url;
  }
  const s = await Settings.findOneAndUpdate({ key: "main" }, { $set: set }, { upsert: true, new: true, runValidators: true });
  res.json({ businessName: s.businessName, portfolio: s.portfolio });
}));

export default router;
