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
    address: { type: String, default: "", trim: true, maxlength: 200 },   // optional: where the work / purchase was
    category: { type: String, default: "Other", trim: true, index: true },
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
    category: { type: String, default: "Other", trim: true, index: true },
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
  { category: { type: String, unique: true, required: true, trim: true }, limit: { type: Number, required: true, min: 0 } },
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
    employee: { type: String, default: "", trim: true, index: true },
    employeePhone: { type: String, default: "", trim: true },
    site: { type: String, required: true, trim: true },          // area / site / project where the work is done
    areaSqft: { type: Number, default: 0, min: 0 },
    ratePerSqft: { type: Number, default: 0, min: 0 },
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

// A price quotation for a (possible) customer. It becomes an invoice only when it is confirmed.
const quoteItemSchema = new mongoose.Schema({ description: { type: String, default: "" }, qty: { type: Number, default: 1, min: 0 }, unit: { type: String, default: "" }, rate: { type: Number, default: 0, min: 0 } }, { _id: false });
const quoteSectionSchema = new mongoose.Schema({ title: { type: String, default: "" }, items: { type: [quoteItemSchema], default: [] } }, { _id: false });
const quotationSchema = new mongoose.Schema(
  {
    reference: { type: String, unique: true, index: true },
    title: { type: String, default: "", trim: true },            // scope of work
    customer: { type: String, default: "", trim: true },         // all customer details are optional until the quotation is confirmed
    customerPhone: { type: String, default: "", trim: true },
    customerEmail: { type: String, default: "", trim: true },
    house: { type: String, default: "", trim: true },
    address: { type: String, default: "", trim: true },
    date: { type: Date, default: Date.now },
    validUntil: { type: Date },
    sections: { type: [quoteSectionSchema], default: [] },
    discount: { type: Number, default: 0, min: 0 },
    taxPercent: { type: Number, default: 0, min: 0, max: 100 },
    subtotal: { type: Number, default: 0 }, tax: { type: Number, default: 0 }, total: { type: Number, default: 0 },   // always calculated on the server
    terms: { type: String, default: "" },
    notes: { type: String, default: "" },
    extras: { type: [{ label: { type: String, default: "" }, value: { type: String, default: "" }, _id: false }], default: [] },   // extra fields added with the + button
    status: { type: String, enum: ["Draft", "Sent", "Confirmed", "Rejected"], default: "Draft", index: true },
    invoiceId: { type: String, default: "" },                    // invoice created when the quotation was confirmed
    confirmedAt: { type: Date }
  },
  { timestamps: true, versionKey: false, toJSON: { transform(_d, ret) { ret.id = ret.reference || String(ret._id); delete ret._id; delete ret.reference; } } }
);
export const Quotation = mongoose.model("Quotation", quotationSchema);

// Single-document app settings (business name etc.), so nothing lives only in the browser.
const settingsSchema = new mongoose.Schema(
  { key: { type: String, default: "main", unique: true }, businessName: { type: String, default: "Finora Services", trim: true }, portfolio: { type: String, default: "", trim: true } },
  { timestamps: true, versionKey: false }
);
export const Settings = mongoose.model("Settings", settingsSchema);

// Expense categories = "profiles". The built-in ones always exist; the user can add more (Home, Site A...).
export const categorySchema = new mongoose.Schema(
  { name: { type: String, required: true, trim: true }, key: { type: String, required: true, unique: true } },
  { timestamps: true, versionKey: false }
);
export const Category = mongoose.model("Category", categorySchema);
