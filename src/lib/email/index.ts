// Transactional email (Resend-backed) — stable send API.
//
// Gating: when RESEND_API_KEY is set we send via Resend; when absent we no-op
// with a structured log so callers work in dev/test without email creds. This
// is a notification side-channel, so we DO NOT fail closed in production on a
// missing key — a send error must never break an order/payout flow. Callers
// should fire-and-forget (await + catch, or void) and never block the primary
// transaction on email.

import { Resend } from "resend";
import { env } from "@/lib/env";
import { log } from "@/lib/log";
import {
  orderConfirmationBody,
  shippingUpdateBody,
  refundConfirmationBody,
  payoutNotificationBody,
  type EmailBody,
} from "@/lib/email/templates";

export type SendResult = { sent: boolean; id?: string; skipped?: boolean };

let client: Resend | null = null;
function getClient(): Resend | null {
  if (!env.RESEND_API_KEY) return null;
  if (!client) client = new Resend(env.RESEND_API_KEY);
  return client;
}

async function send(to: string, body: EmailBody): Promise<SendResult> {
  const resend = getClient();
  const from = env.EMAIL_FROM;
  if (!resend || !from) {
    log.info({ to, subject: body.subject, reason: !from ? "no-from" : "no-key" }, "email skipped (dev/no-op)");
    return { sent: false, skipped: true };
  }
  try {
    const res = await resend.emails.send({
      from,
      to,
      subject: body.subject,
      html: body.html,
      text: body.text,
    });
    if (res.error) {
      log.error({ to, subject: body.subject, err: res.error }, "email send failed");
      return { sent: false };
    }
    return { sent: true, id: res.data?.id };
  } catch (err) {
    log.error({ to, subject: body.subject, err }, "email send threw");
    return { sent: false };
  }
}

export function sendOrderConfirmation(
  to: string,
  inp: { orderId: string; totalUsdCents: number },
): Promise<SendResult> {
  return send(to, orderConfirmationBody(inp));
}

export function sendShippingUpdate(
  to: string,
  inp: { orderId: string; status: string; trackingNumber?: string | null },
): Promise<SendResult> {
  return send(to, shippingUpdateBody(inp));
}

export function sendRefundConfirmation(
  to: string,
  inp: { orderId: string; amountUsdCents: number },
): Promise<SendResult> {
  return send(to, refundConfirmationBody(inp));
}

export function sendPayoutNotification(
  to: string,
  inp: { payoutId: string; amountInrPaise: number },
): Promise<SendResult> {
  return send(to, payoutNotificationBody(inp));
}
