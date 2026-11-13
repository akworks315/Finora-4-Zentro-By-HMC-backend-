import mongoose from "mongoose";

const idOnly = { transform(_d, ret) { ret.id = String(ret._id); delete ret._id; } };

// One payment received against an invoice (an invoice can be paid in several parts).
const paymentSchema = new mongoose.Schema(
  { amount: { type: Number, required: true, min: 0.01 }, date: { type: Date, default: Date.now }, method: { type: String, default: "Cash" }, note: { type: String, default: "" } },
  { _id: true }
);

// Sales == invoices. Every sale has an invoice number stored in `reference`.
const saleSchema = new mongoose.Schema(
  {
    reference: { type: String, unique: true, index: true },
    customer: { type: String, required: true, trim: true },
    customerEmail: { type: String, default: "", trim: true },
    customerPhone: { type: String, default: "", trim: true },   // WhatsApp number of the client
    house: { type: String, default: "", trim: true },           // house / plot / unit number of the site
    address: { type: String, default: "", trim: true },         // street, area, city
    service: { type: String, required: true, trim: true },
    date: { type: Date, default: Date.now },
    dueDate: { type: Date },
    paidAt: { type: Date },   // when the invoice became fully paid (set only when status is Paid)
    amount: { type: Number, required: true, min: 0 },
    paidAmount: { type: Number, default: 0, min: 0 },          // total received so far (sum of payments)
    payments: { type: [paymentSchema], default: [] },
    status: { type: String, enum: ["Paid", "Partial", "Pending", "Overdue", "Cancelled"], default: "Pending", index: true },
    method: { type: String, default: "Not recorded" },
    currency: { type: String, default: "PKR" },
    notes: { type: String, default: "" }
  },
  {
    timestamps: true,
    versionKey: false,
    toJSON: {
      transform(_doc, ret) {
        ret.id = ret.reference || String(ret._id);
        delete ret._id;
        delete ret.reference;
        let payments = (ret.payments || []).map(p => ({ id: String(p._id), amount: p.amount, date: p.date, method: p.method, note: p.note || "" }));
        // Invoices saved before partial payments existed: a "Paid" invoice counts as one full payment.
        if (ret.status === "Paid" && !payments.length) payments = [{ id: "full", amount: ret.amount, date: ret.paidAt || ret.date, method: ret.method, note: "" }];
        ret.payments = payments;
        ret.paidAmount = payments.reduce((a, p) => a + p.amount, 0);
        ret.balance = Math.max(0, Math.round((ret.amount - ret.paidAmount) * 100) / 100);
      }
    }
  }
);
export const Sale = mongoose.model("Sale", saleSchema);

export const CATEGORIES = ["Rent", "Utilities", "Salaries", "Labour", "Materials", "Permits", "Marketing", "Software", "Travel", "Supplies", "Other"];
export const PAYEE_TYPES = ["Employee", "Seller", "Contractor", "Other"];
const expenseSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true },
    payee: { type: String, default: "", trim: true, index: true },   // who the money went to: employee, seller, contractor...
    payeeType: { type: String, enum: PAYEE_TYPES, default: "Other" },
    category: { type: String, enum: CATEGORIES, default: "Other", index: true },
    amount: { type: Number, required: true, min: 0 },
    date: { type: Date, default: Date.now, index: true },
    method: { type: String, default: "Cash" },
    notes: { type: String, default: "" }
  },
  { timestamps: true, versionKey: false, toJSON: idOnly }
);
export const Expense = mongoose.model("Expense", expenseSchema);

// A bill you owe to a person (employee, seller, contractor). It can be paid in parts; every payment is money spent (an expense).
const payableSchema = new mongoose.Schema(
  {
    payee: { type: String, required: true, trim: true, index: true },
    payeePhone: { type: String, default: "", trim: true },          // WhatsApp number of the person you pay
    payeeType: { type: String, enum: PAYEE_TYPES, default: "Other" },
    title: { type: String, required: true, trim: true },             // what the payment is for
    category: { type: String, enum: CATEGORIES, default: "Other", index: true },
    amount: { type: Number, required: true, min: 0 },                // total you have to pay
    date: { type: Date, default: Date.now },
    dueDate: { type: Date },
    paidAt: { type: Date },
    paidAmount: { type: Number, default: 0, min: 0 },
    payments: { type: [paymentSchema], default: [] },
    status: { type: String, enum: ["Paid", "Partial", "Pending", "Cancelled"], default: "Pending", index: true },
    method: { type: String, default: "Not recorded" },
    notes: { type: String, default: "" }
  },
  {
    timestamps: true, versionKey: false,
    toJSON: {
      transform(_d, ret) {
        ret.id = String(ret._id); delete ret._id;
        ret.payments = (ret.payments || []).map(p => ({ id: String(p._id), amount: p.amount, date: p.date, method: p.method, note: p.note || "" }));
        ret.paidAmount = ret.payments.reduce((a, p) => a + p.amount, 0);
        ret.balance = Math.max(0, Math.round((ret.amount - ret.paidAmount) * 100) / 100);
      }
    }
  }
);
export const Payable = mongoose.model("Payable", payableSchema);

// One monthly limit per category.
const budgetSchema = new mongoose.Schema(
  { category: { type: String, enum: CATEGORIES, unique: true, required: true }, limit: { type: Number, required: true, min: 0 } },
  { timestamps: true, versionKey: false, toJSON: idOnly }
);
export const Budget = mongoose.model("Budget", budgetSchema);

// Construction work given to an employee: area x rate = amount, plus the official working permission of the site.
const renewalSchema = new mongoose.Schema(
  { permitNo: { type: String, default: "" }, permitStart: { type: Date }, permitDue: { type: Date }, renewedAt: { type: Date, default: Date.now }, note: { type: String, default: "" } },
  { _id: true }
);
const workSchema = new mongoose.Schema(
  {
    employee: { type: String, required: true, trim: true, index: true },
    employeePhone: { type: String, default: "", trim: true },
    site: { type: String, required: true, trim: true },          // area / site / project where the work is done
    areaSqft: { type: Number, required: true, min: 0 },
    ratePerSqft: { type: Number, required: true, min: 0 },
    amount: { type: Number, default: 0, min: 0 },                // areaSqft x ratePerSqft, always calculated on the server
    status: { type: String, enum: ["Active", "Completed", "Cancelled"], default: "Active", index: true },
    startedOn: { type: Date },                                   // when the employee started the work
    permitNo: { type: String, default: "", trim: true },
    permitAuthority: { type: String, default: "", trim: true },  // who issued the working permission
    permitStart: { type: Date },
    permitDue: { type: Date, index: true },                      // permission expiry date
    permitHistory: { type: [renewalSchema], default: [] },       // earlier permission periods, kept for records
    notes: { type: String, default: "" }
  },
  {
    timestamps: true, versionKey: false,
    toJSON: { transform(_d, ret) { ret.id = String(ret._id); delete ret._id; ret.permitHistory = (ret.permitHistory || []).map(h => ({ id: String(h._id), permitNo: h.permitNo, permitStart: h.permitStart, permitDue: h.permitDue, renewedAt: h.renewedAt, note: h.note })); } }
  }
);
export const Work = mongoose.model("Work", workSchema);

// Single-document app settings (business name etc.), so nothing lives only in the browser.
const settingsSchema = new mongoose.Schema(
  { key: { type: String, default: "main", unique: true }, businessName: { type: String, default: "Finora Services", trim: true }, portfolio: { type: String, default: "", trim: true } },
  { timestamps: true, versionKey: false }
);
export const Settings = mongoose.model("Settings", settingsSchema);
