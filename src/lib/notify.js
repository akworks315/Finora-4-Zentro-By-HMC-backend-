// WhatsApp notifications when an invoice or payment changes.
//
// Automatic sending uses the WhatsApp Business Cloud API (Meta). Set these on the backend (Vercel > Settings > Environment Variables):
//   WHATSAPP_TOKEN      permanent access token
//   WHATSAPP_PHONE_ID   the "Phone number ID" of your WhatsApp Business number
//   WHATSAPP_OWNER      (optional) your own number, you get a copy of every message
// Without them nothing is sent from the server. The API still returns the ready-made message so the website can open the chat for you.
import { money2 } from "./payments.js";

const fmt = n => "Rs " + Math.round(Number(n) || 0).toLocaleString("en-US");
const day = d => d ? new Date(d).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric", timeZone: "UTC" }) : "";

// WhatsApp wants the international number without "+". Pakistani numbers (03xx...) become 92 3xx...
export function waNumber(input) {
  const raw = String(input || "").trim();
  if (!raw) return "";
  const d = raw.replace(/\D/g, "");
  if (raw.startsWith("+")) return d;
  if (d.startsWith("00")) return d.slice(2);
  if (d.startsWith("0")) return "92" + d.slice(1);
  if (d.length === 10 && d.startsWith("3")) return "92" + d;
  return d;
}

export function buildMessage(kind, sale, extra = {}) {
  const inv = sale.reference || sale.id;
  const balance = Math.max(0, money2(sale.amount - (sale.paidAmount || 0)));
  const head = `Hello ${sale.customer},`;
  const foot = "Thank you for your business.";
  const where = [sale.house, sale.address].filter(Boolean).join(", ");
  const place = where ? [`Site: ${where}`] : [];
  switch (kind) {
    case "payment":
      return [head, `We received your payment of ${fmt(extra.amount)} for invoice ${inv}.`, ...place,
        `Invoice total: ${fmt(sale.amount)}`, `Paid so far: ${fmt(sale.paidAmount)}`,
        balance > 0 ? `Remaining: ${fmt(balance)}${sale.dueDate ? ` (due ${day(sale.dueDate)})` : ""}` : "Status: PAID IN FULL. Thank you!", foot].join("\n");
    case "payment-removed":
      return [head, `A payment entry on invoice ${inv} was corrected.`, `Paid so far: ${fmt(sale.paidAmount)}`, `Remaining: ${fmt(balance)}`, foot].join("\n");
    case "created":
      return [head, `Your invoice ${inv} has been created.`, ...place, `Amount: ${fmt(sale.amount)}`, sale.paidAmount > 0 ? `Received: ${fmt(sale.paidAmount)}` : "", balance > 0 ? `Remaining: ${fmt(balance)}${sale.dueDate ? ` (due ${day(sale.dueDate)})` : ""}` : "Status: PAID", foot].filter(Boolean).join("\n");
    case "cancelled":
      return [head, `Invoice ${inv} has been cancelled.`, foot].join("\n");
    default:
      return [head, `Your invoice ${inv} was updated.`, ...(extra.changes || []), `Amount: ${fmt(sale.amount)}`, `Paid so far: ${fmt(sale.paidAmount)}`, `Remaining: ${fmt(balance)}${sale.dueDate ? ` (due ${day(sale.dueDate)})` : ""}`, foot].join("\n");
  }
}

async function post(to, body) {
  const ctrl = new AbortController(), timer = setTimeout(() => ctrl.abort(), 7000);
  try {
    const r = await fetch(`https://graph.facebook.com/v21.0/${process.env.WHATSAPP_PHONE_ID}/messages`, {
      method: "POST", signal: ctrl.signal,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}` },
      body: JSON.stringify({ messaging_product: "whatsapp", to, type: "text", text: { preview_url: false, body } })
    });
    if (!r.ok) { const j = await r.json().catch(() => ({})); return { ok: false, reason: j?.error?.message || `WhatsApp API error ${r.status}` }; }
    return { ok: true };
  } catch (e) { return { ok: false, reason: e.name === "AbortError" ? "WhatsApp API timed out" : e.message }; }
  finally { clearTimeout(timer); }
}

async function deliver(phone, text, label) {
  const to = waNumber(phone);
  const out = { text, to, sent: false, reason: "" };
  if (!to) { out.reason = "No WhatsApp number saved."; return out; }
  if (!process.env.WHATSAPP_TOKEN || !process.env.WHATSAPP_PHONE_ID) { out.reason = "Automatic WhatsApp is not set up on the server."; return out; }
  const r = await post(to, text);
  out.sent = r.ok; out.reason = r.ok ? "" : r.reason;
  const owner = waNumber(process.env.WHATSAPP_OWNER);
  if (r.ok && owner && owner !== to) await post(owner, `[Copy] ${label}\n${text}`);
  return out;
}

// Never throws: a failed message must not undo the payment that was just saved.
export const notifyCustomer = (kind, sale, extra) => deliver(sale.customerPhone, buildMessage(kind, sale, extra), sale.customer);

// Messages for the person YOU pay (employee / seller / contractor) about a bill.
export function buildPayeeMessage(kind, bill, extra = {}) {
  const balance = Math.max(0, money2(bill.amount - (bill.paidAmount || 0)));
  const head = `Hello ${bill.payee},`, foot = "Thank you.";
  const state = [`Total agreed: ${fmt(bill.amount)}`, `Paid so far: ${fmt(bill.paidAmount)}`, balance > 0 ? `Remaining: ${fmt(balance)}${bill.dueDate ? ` (due ${day(bill.dueDate)})` : ""}` : "Status: PAID IN FULL"];
  switch (kind) {
    case "payment": return [head, `We have paid you ${fmt(extra.amount)} for "${bill.title}".`, ...state, foot].join("\n");
    case "payment-removed": return [head, `A payment entry for "${bill.title}" was corrected.`, ...state, foot].join("\n");
    case "cancelled": return [head, `The payment for "${bill.title}" has been cancelled.`, foot].join("\n");
    default: return [head, `Your payment details for "${bill.title}" were updated.`, ...(extra.changes || []), ...state, foot].join("\n");
  }
}
export const notifyPayee = (kind, bill, extra) => deliver(bill.payeePhone, buildPayeeMessage(kind, bill, extra), bill.payee);
