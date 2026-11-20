# Finora backend (v4)

Express + MongoDB (Mongoose). Deployed on Vercel: https://finora-4-zentro-by-hmc-backend.vercel.app

## Vercel setup (needed once so the database works)
1. Vercel > this backend project > Settings > Environment Variables: add `MONGODB_URI` (and `MONGODB_DB`, optional).
2. MongoDB Atlas > Network Access: allow `0.0.0.0/0` (Vercel has no fixed IP).
3. Redeploy, then open `/api/health`. It must show `"database":"connected"` and `"version":"4.1.0"`.

## API (no login)
- `GET/POST /api/sales`, `PATCH/DELETE /api/sales/:invoiceNumber`
  - sale fields: `customer`, `customerPhone`, `house`, `address`, `service`, `amount`, `date`, `dueDate`, `notes`, optional `paidNow`
  - status is automatic: **Pending** → **Partial** (some money received) → **Paid** (fully received). `Overdue` is derived from the due date.
- `POST /api/sales/:invoiceNumber/payments` `{ amount, method, date, note }`: record a part or full payment
- `DELETE /api/sales/:invoiceNumber/payments/:paymentId`: remove a wrongly entered payment
- `GET/POST /api/categories`: expense categories ("profiles"). Built-in ones plus any the user creates (Home, Site A...); custom names are accepted by expenses, bills and budgets
- `GET/POST /api/expenses` (`payee`, `payeeType`, optional `address`; search with `?q=name` or `?payee=Exact Name`), `DELETE /api/expenses/:id`
- `GET/POST /api/payables`, `PATCH/DELETE /api/payables/:id`: bills you owe to an employee / seller (`payee`, `payeePhone`, `title`, `amount`, `dueDate`, optional `address`, optional `paidNow`)
  - `POST /api/payables/:id/payments`, `DELETE /api/payables/:id/payments/:paymentId`: part payments; each one counts as an expense and the person gets a WhatsApp update
- `GET/POST /api/works`, `PATCH/DELETE /api/works/:id`: working permissions (area / employee / permit dates; area × rate are optional)
- `POST /api/works/:id/renew` `{ permitStart, permitDue, permitNo, note }`: renew a permission (old period kept in history)
- `GET /api/budgets`, `PUT /api/budgets/:category`
- `GET/PUT /api/settings`
- `POST /api/integrations/sales` with the `x-sync-key` header
- `GET /api/health`

## WhatsApp updates
When a payment is recorded, removed, or an invoice's amount / due date changes, the API builds a message for the customer and returns it as `notification`.
If `WHATSAPP_TOKEN` and `WHATSAPP_PHONE_ID` are set (WhatsApp Business Cloud API), it is sent automatically (`WHATSAPP_OWNER` gets a copy).
Otherwise the website shows a "Send on WhatsApp" button that opens the customer's chat with the message ready. Note: Meta only allows free-text messages
to a customer who messaged your business number in the last 24 hours; outside that window you need an approved message template.

There is no authentication, so anyone who knows the backend URL can read and change the data. Keep the URL private or enable Vercel Deployment Protection.

## Quotations (v4.2)
- `GET/POST /api/quotations`: list / create. A quotation has `title` (scope), `sections: [{ title, items: [{ description, qty, unit, rate }] }]`, optional `discount`, `taxPercent`, `terms`, `notes`, `validUntil`, `extras: [{ label, value }]` and **optional** customer details (`customer`, `customerPhone`, `customerEmail`, `house`, `address`). Totals are calculated on the server. Numbers are `QT-1001`, `QT-1002`...
- `PATCH /api/quotations/:id`: edit (not allowed once confirmed). `status` may be `Draft`, `Sent` or `Rejected`.
- `POST /api/quotations/:id/duplicate`: copy without customer details, to reuse for someone else.
- `POST /api/quotations/:id/confirm` `{ customer, customerPhone, customerEmail, house, address, dueDate }`: the customer accepted. **Only now** an invoice is created (`INV-xxxx`) for that customer; the quotation becomes `Confirmed` and keeps `invoiceId`. A customer name is required. Confirming twice is refused.
- `DELETE /api/categories/:name`: delete a profile you created; its expenses and bills move to "Other".
