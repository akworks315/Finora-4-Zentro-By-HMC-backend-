// Quotation maths and input cleaning (pure functions, no database).
import { money2 } from "./payments.js";

const str = (v, max) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, max);
const multi = (v, max) => String(v ?? "").replace(/\r/g, "").trim().slice(0, max);
const num = (v, fallback = 0) => { const n = Number(v); return Number.isFinite(n) && n >= 0 ? n : fallback; };

export const itemAmount = it => money2((Number(it.qty) || 0) * (Number(it.rate) || 0));

export function quoteTotals(q) {
  const subtotal = money2((q.sections || []).reduce((a, s) => a + (s.items || []).reduce((b, it) => b + itemAmount(it), 0), 0));
  const discount = Math.min(money2(q.discount), subtotal);
  const tax = money2(((subtotal - discount) * (Number(q.taxPercent) || 0)) / 100);
  return { subtotal, discount, tax, total: money2(subtotal - discount + tax) };
}

// Turns request data into a clean quotation. Everything about the customer is optional.
export function cleanQuote(input, { partial = false } = {}) {
  const doc = {}, has = k => input[k] !== undefined;
  if (has("title")) doc.title = str(input.title, 160);
  for (const [k, max] of [["customer", 120], ["customerPhone", 30], ["customerEmail", 120], ["house", 80], ["address", 200]]) if (has(k)) doc[k] = str(input[k], max);
  if (doc.customerPhone) {
    const digits = doc.customerPhone.replace(/\D/g, "");
    if (!/^[+\d][\d\s\-()]*$/.test(doc.customerPhone) || digits.length < 7 || digits.length > 15) return { error: "WhatsApp number must be 7 to 15 digits, e.g. 0300 1234567." };
  }
  if (has("date")) { const d = new Date(input.date); doc.date = Number.isNaN(+d) ? new Date() : d; }
  if (has("validUntil")) { const d = input.validUntil ? new Date(input.validUntil) : null; doc.validUntil = d && !Number.isNaN(+d) ? d : null; }
  if (has("terms")) doc.terms = multi(input.terms, 4000);
  if (has("notes")) doc.notes = multi(input.notes, 4000);
  if (has("discount")) { doc.discount = num(input.discount); }
  if (has("taxPercent")) { const t = num(input.taxPercent); if (t > 100) return { error: "Tax percent cannot be more than 100." }; doc.taxPercent = t; }
  if (has("extras")) {
    if (!Array.isArray(input.extras)) return { error: "Extra fields must be a list." };
    doc.extras = input.extras.slice(0, 20).map(e => ({ label: str(e?.label, 60), value: str(e?.value, 300) })).filter(e => e.label || e.value);
  }
  if (has("sections")) {
    if (!Array.isArray(input.sections)) return { error: "Sections must be a list." };
    if (input.sections.length > 40) return { error: "A quotation can have at most 40 sections." };
    let count = 0;
    doc.sections = input.sections.map(s => ({
      title: str(s?.title, 160),
      items: (Array.isArray(s?.items) ? s.items : []).map(it => ({ description: multi(it?.description, 1000), qty: num(it?.qty, 1), unit: str(it?.unit, 12), rate: num(it?.rate) }))
        .filter(it => it.description || it.rate > 0)
    })).filter(s => s.title || s.items.length);
    doc.sections.forEach(s => { count += s.items.length; });
    if (count > 300) return { error: "A quotation can have at most 300 items." };
  }
  if (!partial && !doc.sections) doc.sections = [];
  return { doc };
}
