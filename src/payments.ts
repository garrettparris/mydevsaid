import Stripe from "stripe";
import type { Store } from "./store.ts";

export const PRICE_CENTS = 10_000;
export type PaymentReceipt = { eventId: string; orderId: string; checkoutId: string };
export type CheckoutState = { id: string; orderId: string; status: "open" | "complete" | "expired"; paymentStatus: "paid" | "unpaid" | "no_payment_required"; url: string | null };
export interface PaymentProvider {
  createCheckout(orderId: string, generation?: number): Promise<{ id: string; url: string }>;
  retrieveCheckout?(checkoutId: string): Promise<CheckoutState>;
  verifyWebhook(body: Buffer, signature: string): PaymentReceipt | null;
}
export const checkoutKey = (orderId: string, generation: number) => generation === 0 ? `investigation-${orderId}` : `investigation-${orderId}-${generation}`;
const validUrl = (value: string) => { const url = URL.parse(value); return url?.protocol === "https:" && url.hostname === "checkout.stripe.com" && !url.port && !url.username && !url.password; };
function sessionOrder(session: Stripe.Checkout.Session): string {
  if (session.mode !== "payment" || session.amount_total !== PRICE_CENTS || session.currency !== "usd"
    || !session.client_reference_id || session.metadata?.orderId !== session.client_reference_id) throw new Error("Checkout amount, currency, or order did not match");
  return session.client_reference_id;
}

/** Only a signed payment webhook can fund an order; retrieval can only recover checkout. */
export async function recoverCheckout(store: Store, payments: PaymentProvider, orderId: string): Promise<void> {
  let order = store.getOrder(orderId);
  if (!order || order.payment !== "pending") return;
  if (order.checkoutId) {
    if (!payments.retrieveCheckout) throw new Error("Authoritative checkout retrieval is unavailable");
    const session = await payments.retrieveCheckout(order.checkoutId);
    if (session.id !== order.checkoutId || session.orderId !== order.id || !["open", "complete", "expired"].includes(session.status)
      || !["paid", "unpaid", "no_payment_required"].includes(session.paymentStatus)) throw new Error("Checkout identity or state is invalid");
    const current = store.getOrder(order.id)!;
    if (current.payment !== "pending" || current.checkoutId !== order.checkoutId) return;
    if (session.status === "complete" || session.paymentStatus !== "unpaid") { store.withholdCheckout(order.id); return; }
    if (session.status === "open") {
      if (!session.url || !validUrl(session.url)) throw new Error("Open checkout URL is unavailable");
      store.recordCheckout(order.id, order.checkoutGeneration ?? 0, { id: session.id, url: session.url }); return;
    }
    order = store.reserveCheckout(order.id, session.id) ?? undefined;
  } else order = store.reserveCheckout(order.id) ?? undefined;
  if (!order) return;
  const generation = order.checkoutGeneration ?? 0;
  const checkout = await payments.createCheckout(order.id, generation);
  if (!checkout.id || !validUrl(checkout.url)) throw new Error("Invalid created checkout");
  store.recordCheckout(order.id, generation, checkout);
}

export function stripePayments(secret: string, webhookSecret: string, origin: string, client?: Stripe): PaymentProvider {
  const stripe = client ?? new Stripe(secret, { timeout: 15_000, maxNetworkRetries: 1 });
  return {
    async createCheckout(orderId, generation = 0) {
      if (!Number.isSafeInteger(generation) || generation < 0 || generation > 8) throw new Error("Invalid checkout generation");
      const session = await stripe.checkout.sessions.create({
        mode: "payment", client_reference_id: orderId, metadata: generation ? { orderId, checkoutGeneration: String(generation) } : { orderId }, payment_method_types: ["card"],
        line_items: [{ quantity: 1, price_data: { currency: "usd", unit_amount: PRICE_CENTS,
          product_data: { name: "mydevsaid technical investigation", description: "Bounded, evidence-backed report with human review. Not a security audit or certification." } } }],
        success_url: `${origin}/?order=${encodeURIComponent(orderId)}&checkout=returned`,
        cancel_url: `${origin}/?order=${encodeURIComponent(orderId)}&checkout=cancelled`,
      }, { idempotencyKey: checkoutKey(orderId, generation) });
      if (sessionOrder(session) !== orderId || (session.metadata?.checkoutGeneration ?? "0") !== String(generation)
        || session.status !== "open" || session.payment_status !== "unpaid" || !session.url || !validUrl(session.url)) throw new Error("Created checkout did not match the order");
      return { id: session.id, url: session.url };
    },
    async retrieveCheckout(checkoutId) {
      const session = await stripe.checkout.sessions.retrieve(checkoutId);
      const orderId = sessionOrder(session);
      if (session.id !== checkoutId || (session.status !== "open" && session.status !== "complete" && session.status !== "expired")
        || (session.payment_status !== "paid" && session.payment_status !== "unpaid" && session.payment_status !== "no_payment_required")) throw new Error("Retrieved checkout identity or state is invalid");
      return { id: session.id, orderId, status: session.status as CheckoutState["status"], paymentStatus: session.payment_status as CheckoutState["paymentStatus"], url: session.url };
    },
    verifyWebhook(body, signature) {
      const event = stripe.webhooks.constructEvent(body, signature, webhookSecret);
      if (!["checkout.session.completed", "checkout.session.async_payment_succeeded"].includes(event.type)) return null;
      const session = event.data.object as Stripe.Checkout.Session;
      if (session.payment_status !== "paid") return null;
      return { eventId: event.id, orderId: sessionOrder(session), checkoutId: session.id };
    },
  };
}
