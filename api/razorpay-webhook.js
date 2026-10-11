// Razorpay webhook (India payments). Backup for when a student pays with UPI but closes the tab before the
// page confirms it: Razorpay tells us about the payment here and the Pro pass is saved anyway.
// Set it up in Razorpay: Settings -> Webhooks -> URL https://essaywiz.app/api/razorpay-webhook, event "payment.captured".
// Nothing in the message is trusted: the payment is looked up again with Razorpay's API before Pro is switched on.
import { razorpayEnabled, saveInrPayment } from "./_billing.js";

export const config = { maxDuration: 30 };

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ code: "method" });
  if (!razorpayEnabled()) return res.status(200).json({ ok: false });
  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }
  const pay = (((body || {}).payload || {}).payment || {}).entity || {};
  if (!pay.id || !/^payment\.(captured|authorized)$/.test(String((body || {}).event || ""))) return res.status(200).json({ ok: true, skipped: true });
  try { await saveInrPayment(String(pay.id), null); return res.status(200).json({ ok: true }); }
  catch (e) { console.error("Razorpay webhook: payment not saved", pay.id, e && (e.code || e.message)); return res.status(200).json({ ok: false }); }
}
