import mongoose from "mongoose";

// Sales == invoices. Every sale has an invoice number stored in `reference`.
const saleSchema = new mongoose.Schema(
  {
    reference: { type: String, unique: true, index: true },
    customer: { type: String, required: true, trim: true },
    customerEmail: { type: String, default: "", trim: true },
    customerPhone: { type: String, default: "", trim: true },   // WhatsApp number of the client
    service: { type: String, required: true, trim: true },
    date: { type: Date, default: Date.now },
    dueDate: { type: Date },
    paidAt: { type: Date },   // when the money was received (income is counted in this month)
    amount: { type: Number, required: true, min: 0 },
    status: { type: String, enum: ["Paid", "Pending", "Overdue", "Cancelled"], default: "Pending", index: true },
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
      }
    }
  }
);

export const Sale = mongoose.model("Sale", saleSchema);

export const CATEGORIES = ["Rent", "Utilities", "Salaries", "Marketing", "Software", "Travel", "Supplies", "Other"];
const expenseSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true },
    category: { type: String, enum: CATEGORIES, default: "Other", index: true },
    amount: { type: Number, required: true, min: 0 },
    date: { type: Date, default: Date.now, index: true },
    method: { type: String, default: "Cash" },
    notes: { type: String, default: "" }
  },
  { timestamps: true, versionKey: false,
    toJSON: { transform(_d, ret) { ret.id = String(ret._id); delete ret._id; } } }
);
export const Expense = mongoose.model("Expense", expenseSchema);

// One monthly limit per category.
const budgetSchema = new mongoose.Schema(
  { category: { type: String, enum: CATEGORIES, unique: true, required: true }, limit: { type: Number, required: true, min: 0 } },
  { timestamps: true, versionKey: false, toJSON: { transform(_d, ret) { ret.id = String(ret._id); delete ret._id; } } }
);
export const Budget = mongoose.model("Budget", budgetSchema);

// Single-document app settings (business name etc.), so nothing lives only in the browser.
const settingsSchema = new mongoose.Schema(
  { key: { type: String, default: "main", unique: true }, businessName: { type: String, default: "Finora Services", trim: true }, portfolio: { type: String, default: "", trim: true } },
  { timestamps: true, versionKey: false }
);
export const Settings = mongoose.model("Settings", settingsSchema);
