// Email content builders (Module 4/5).
//
// Each builder returns a { subject, html, text } payload from the minimal data
// it needs. The send API in ./index.ts is unchanged — it just consumes these.
// HTML is email-client-safe: table-based layout, all styles inlined, no <head>
// or external assets. Keep this file self-contained (no env / SDK imports) so
// templates stay pure and trivially testable.

export type EmailBody = { subject: string; html: string; text: string };

// --- Brand tokens (kept local so templates render identically anywhere) ---
const BRAND = "Shezmin";
const COLORS = {
  ink: "#1a1a1a",
  body: "#3f3f46",
  muted: "#71717a",
  border: "#ece7e1",
  bg: "#f5f1ec", // warm boutique canvas
  card: "#ffffff",
  accent: "#7c4a3f", // warm terracotta/brown
  accentSoft: "#f3ece8",
};

function money(cents: number, symbol: string): string {
  return `${symbol}${(cents / 100).toFixed(2)}`;
}

// Escape user-facing dynamic values before interpolating into HTML.
function esc(v: string): string {
  return v
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

type Row = { label: string; value: string; strong?: boolean };

type Shell = {
  subject: string;
  preheader: string; // hidden inbox-preview snippet
  heading: string;
  intro: string;
  rows?: Row[];
  outro?: string;
  cta?: { label: string; url: string };
};

// Renders the shared branded HTML shell + a plain-text fallback.
function render(s: Shell): EmailBody {
  const rowsHtml = (s.rows ?? [])
    .map(
      (r) => `
              <tr>
                <td style="padding:10px 0;border-bottom:1px solid ${COLORS.border};color:${COLORS.muted};font-size:14px;">${esc(
                  r.label,
                )}</td>
                <td align="right" style="padding:10px 0;border-bottom:1px solid ${COLORS.border};color:${COLORS.ink};font-size:14px;font-weight:${
                  r.strong ? "700" : "500"
                };">${esc(r.value)}</td>
              </tr>`,
    )
    .join("");

  const ctaHtml = s.cta
    ? `
              <tr><td style="padding:28px 0 4px;">
                <a href="${esc(s.cta.url)}" style="display:inline-block;background:${COLORS.accent};color:#ffffff;text-decoration:none;font-size:15px;font-weight:600;padding:13px 26px;border-radius:8px;">${esc(
                  s.cta.label,
                )}</a>
              </td></tr>`
    : "";

  const outroHtml = s.outro
    ? `<tr><td style="padding:22px 0 0;color:${COLORS.muted};font-size:13px;line-height:1.6;">${esc(
        s.outro,
      )}</td></tr>`
    : "";

  const html = `<!-- ${esc(s.subject)} -->
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${esc(s.preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${COLORS.bg};margin:0;padding:0;">
  <tr><td align="center" style="padding:32px 16px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:${COLORS.card};border:1px solid ${COLORS.border};border-radius:14px;overflow:hidden;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;">
      <tr><td style="background:${COLORS.accent};padding:22px 32px;">
        <span style="color:#ffffff;font-size:20px;font-weight:700;letter-spacing:0.5px;">${BRAND}</span>
      </td></tr>
      <tr><td style="padding:32px 32px 8px;">
        <h1 style="margin:0 0 12px;color:${COLORS.ink};font-size:22px;font-weight:700;line-height:1.3;">${esc(
          s.heading,
        )}</h1>
        <p style="margin:0;color:${COLORS.body};font-size:15px;line-height:1.6;">${esc(s.intro)}</p>
      </td></tr>
      <tr><td style="padding:8px 32px 0;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${rowsHtml}${ctaHtml}${outroHtml}</table>
      </td></tr>
      <tr><td style="padding:28px 32px 34px;">
        <div style="border-top:1px solid ${COLORS.border};padding-top:18px;color:${COLORS.muted};font-size:12px;line-height:1.6;">
          You're receiving this because you have activity on your ${BRAND} account.<br/>
          &copy; ${new Date().getFullYear()} ${BRAND}. All rights reserved.
        </div>
      </td></tr>
    </table>
  </td></tr>
</table>`;

  const textRows = (s.rows ?? []).map((r) => `${r.label}: ${r.value}`);
  const text = [
    BRAND,
    "",
    s.heading,
    "",
    s.intro,
    ...(textRows.length ? ["", ...textRows] : []),
    ...(s.cta ? ["", `${s.cta.label}: ${s.cta.url}`] : []),
    ...(s.outro ? ["", s.outro] : []),
    "",
    `— ${BRAND}`,
  ].join("\n");

  return { subject: s.subject, html, text };
}

export function orderConfirmationBody(inp: {
  orderId: string;
  totalUsdCents: number;
}): EmailBody {
  return render({
    subject: `Your ${BRAND} order is confirmed`,
    preheader: `Order ${inp.orderId} — ${money(inp.totalUsdCents, "$")}`,
    heading: "Thank you for your order",
    intro: `We've received your order and payment. Here are the details — we'll email you again as soon as it ships.`,
    rows: [
      { label: "Order number", value: inp.orderId },
      { label: "Order total", value: money(inp.totalUsdCents, "$"), strong: true },
    ],
    outro: "Questions about your order? Just reply to this email and we'll help.",
  });
}

export function shippingUpdateBody(inp: {
  orderId: string;
  status: string;
  trackingNumber?: string | null;
}): EmailBody {
  const rows: Row[] = [
    { label: "Order number", value: inp.orderId },
    { label: "Status", value: inp.status, strong: true },
  ];
  if (inp.trackingNumber) {
    rows.push({ label: "Tracking number", value: inp.trackingNumber });
  }
  return render({
    subject: `Shipping update for order ${inp.orderId}`,
    preheader: `Order ${inp.orderId} is now ${inp.status}`,
    heading: "Your order is on the move",
    intro: `There's an update on your ${BRAND} order.`,
    rows,
    outro: inp.trackingNumber
      ? "Use the tracking number above with the carrier to follow your parcel."
      : "We'll share tracking details as soon as they're available.",
  });
}

export function refundConfirmationBody(inp: {
  orderId: string;
  amountUsdCents: number;
}): EmailBody {
  return render({
    subject: `Refund issued for order ${inp.orderId}`,
    preheader: `We've refunded ${money(inp.amountUsdCents, "$")} for order ${inp.orderId}`,
    heading: "Your refund is on its way",
    intro: `We've processed a refund for your order. It may take a few business days to appear on your statement, depending on your bank.`,
    rows: [
      { label: "Order number", value: inp.orderId },
      { label: "Refund amount", value: money(inp.amountUsdCents, "$"), strong: true },
    ],
    outro: "If you don't see the refund after 5–10 business days, reply and we'll investigate.",
  });
}

export function payoutNotificationBody(inp: {
  payoutId: string;
  amountInrPaise: number;
}): EmailBody {
  return render({
    subject: `Your ${BRAND} payout is on its way`,
    preheader: `Payout ${inp.payoutId} — ${money(inp.amountInrPaise, "₹")}`,
    heading: "Payout sent to your bank",
    intro: `Good news — a payout for your ${BRAND} sales has been sent to your registered bank account.`,
    rows: [
      { label: "Payout reference", value: inp.payoutId },
      { label: "Amount", value: money(inp.amountInrPaise, "₹"), strong: true },
    ],
    outro: "Funds typically settle within 1–2 business days. You can review payouts anytime in your seller dashboard.",
  });
}
