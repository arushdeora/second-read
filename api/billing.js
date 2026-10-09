import { guard, fail, tracked } from "./_lib.js";
import { status, activate, createPass, capturePass } from "./_billing.js";

// POST { action: "status" }                      -> plan, credits used today, PayPal button settings
// POST { action: "activate", subscriptionID }    -> confirm a new PayPal subscription for this Google account
// POST { action: "pass_create", period }         -> PayPal order for a one-time Apple Pay pass ("month" or "year")
// POST { action: "pass_capture", orderID }       -> take the Apple Pay payment and switch on Pro
export const config = { maxDuration: 30 };

async function handler(req, res) {
  const body = await guard(req, res, { cost: 0 }); if (!body) return;
  const user = req.srUser;
  const hint = String(req.headers["x-sr-subscription"] || "");
  try {
    if (body.action === "pass_create") return res.status(200).json({ id: await createPass(user, String(body.period || "")) });
    if (body.action === "pass_capture") await capturePass(user, String(body.orderID || ""));
    if (body.action === "activate") {
      const s = await activate(user, String(body.subscriptionID || ""));
      if (!s.pro) return res.status(400).json({ code: "not_active" });
    }
    return res.status(200).json(await status(user, body.action === "activate" ? String(body.subscriptionID) : hint));
  } catch (e) { return fail(res, e); }
}

export default tracked("billing", handler);
