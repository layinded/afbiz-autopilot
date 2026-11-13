/** Naira formatting for user-facing replies. Backend-computed numbers only. */
export function fmtMoney(value: number): string {
  const isWhole = Number.isInteger(value);
  return new Intl.NumberFormat("en-NG", {
    style: "currency",
    currency: "NGN",
    minimumFractionDigits: isWhole ? 0 : 2,
    maximumFractionDigits: 2,
  }).format(value);
}
