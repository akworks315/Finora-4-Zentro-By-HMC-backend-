import { Router } from "express";
import { Sale, Expense, Budget, Settings, CATEGORIES } from "../models/index.js";
import { asyncRoute, clean, toDate } from "../lib/util.js";

export const API_VERSION = "3.1.0"; // frontend checks this to detect an outdated deployment
const router = Router();
const STATUSES = ["Paid", "Pending", "Overdue", "Cancelled"];

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
  if (has("customerPhone")) {
    doc.customerPhone = clean(input.customerPhone);
    const digits = doc.customerPhone.replace(/\D/g, "");
    if (doc.customerPhone && (!/^[+\d][\d\s\-()]*$/.test(doc.customerPhone) || digits.length < 7 || digits.length > 15)) return { error: "WhatsApp number must be 7 to 15 digits, e.g. 0300 1234567 or +92 300 1234567." };
  }
  if (has("date")) doc.date = toDate(input.date) || new Date();
  if (has("dueDate")) doc.dueDate = toDate(input.dueDate) || null;
  if (has("status")) {
    if (!STATUSES.includes(input.status)) return { error: "Status must be Paid, Pending, Overdue or Cancelled." };
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

// Service-provider webhook: POST /api/integrations/sales with the x-sync-key header.
router.post("/integrations/sales", asyncRoute(async (req, res) => {
  const expected = process.env.SYNC_API_KEY;
  if (!expected || req.get("x-sync-key") !== expected) return res.status(401).json({ message: "Invalid sync key." });
  const incoming = Array.isArray(req.body) ? req.body : [req.body];
  const saved = [];
  for (const item of incoming) {
    const { doc, error } = buildSale(item || {});
    if (error) return res.status(400).json({ message: error, received: saved.length });
    const reference = clean(item.reference) || (await nextInvoiceNumber());
    if (doc.status === "Paid" && !doc.paidAt) doc.paidAt = doc.date || new Date();
    saved.push(await Sale.create({ ...doc, reference }));
  }
  res.status(201).json({ received: saved.length, records: saved.map(x => x.toJSON()) });
}));

// List all sales (newest first)
router.get("/sales", asyncRoute(async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 1000, 5000);
  const docs = await Sale.find().sort({ date: -1, createdAt: -1 }).limit(limit);
  res.json(docs.map(d => d.toJSON()));
}));

// Create a sale / invoice
router.post("/sales", asyncRoute(async (req, res) => {
  const { doc, error } = buildSale(req.body || {});
  if (error) return res.status(400).json({ message: error });
  if (!doc.date) doc.date = new Date();
  if (doc.status === "Paid" && !doc.paidAt) doc.paidAt = doc.date;

  // Retry once if two invoices are created at the same moment and get the same number.
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const sale = await Sale.create({ ...doc, reference: clean(req.body.reference) || (await nextInvoiceNumber()) });
      return res.status(201).json(sale.toJSON());
    } catch (err) {
      if (err.code !== 11000 || req.body.reference) throw err;
    }
  }
  res.status(409).json({ message: "Could not generate a unique invoice number. Please try again." });
}));

// Update a sale (e.g. mark as paid) — :id is the invoice number
router.patch("/sales/:id", asyncRoute(async (req, res) => {
  const { doc, error } = buildSale(req.body || {}, { partial: true });
  if (error) return res.status(400).json({ message: error });
  const update = { $set: doc };
  if (doc.status === "Paid") {
    const current = await Sale.findOne({ reference: req.params.id }).select("status paidAt").lean();
    if (current && !(current.status === "Paid" && current.paidAt) && !doc.paidAt) doc.paidAt = new Date();
  } else if (doc.status) { delete doc.paidAt; update.$unset = { paidAt: 1 }; }
  const sale = await Sale.findOneAndUpdate({ reference: req.params.id }, update, { new: true, runValidators: true });
  if (!sale) return res.status(404).json({ message: "Invoice not found." });
  res.json(sale.toJSON());
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
