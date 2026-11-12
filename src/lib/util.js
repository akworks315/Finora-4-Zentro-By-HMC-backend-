export const asyncRoute = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
export const clean = value => String(value ?? "").trim();
export const toDate = value => {
  if (!value) return undefined;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? undefined : d;
};
export const escapeRegex = s => String(s ?? "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
