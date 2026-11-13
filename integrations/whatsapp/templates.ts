/**
 * WhatsApp template registry (utility category), lifted from the proven
 * afcloud channel. Template names are lowercase alphanumerics + underscores;
 * body text carries {{param_name}} placeholders with example values; the copy
 * is non-promotional and transaction-specific (utility gate).
 */
import type { SendResult } from "./sender.js";

export interface TemplateParam {
  param_name: string;
  example: string;
}

export interface TemplateButtonRef {
  type: "url" | "quick_reply";
  text: string;
  url?: string;
}

export interface TemplateBlueprint {
  name: string;
  category: "UTILITY";
  language: string;
  header?: { type: "text"; text: string };
  body: string;
  footer?: string;
  buttons: TemplateButtonRef[];
  params: TemplateParam[];
}

export const AFBIZ_TEMPLATES = {
  reminder_notice: {
    name: "reminder_notice",
    category: "UTILITY",
    language: "en",
    body: "AFBiz reminder: {{notice_body}}",
    footer: "AFBiz notice",
    buttons: [],
    params: [
      { param_name: "notice_body", example: "your customer Tunde owes N 7,500, due November 1, 2026" },
    ],
  },
  low_stock_alert: {
    name: "low_stock_alert",
    category: "UTILITY",
    language: "en",
    body: "Stock alert: {{product_name}} is low, {{balance_and_unit}} remaining (threshold: {{threshold_and_unit}}).{{suggested_reorder}}",
    buttons: [],
    params: [
      { param_name: "product_name", example: "Indomie noodles" },
      { param_name: "balance_and_unit", example: "8 cartons" },
      { param_name: "threshold_and_unit", example: "10 cartons" },
      { param_name: "suggested_reorder", example: " Suggested reorder: about 240 pieces." },
    ],
  },
  invoice_paid_confirmation: {
    name: "invoice_paid_confirmation",
    category: "UTILITY",
    language: "en",
    body: "Payment received for invoice {{invoice_id}}, {{amount}}, on {{paid_date}}.",
    footer: "Thank you for banking with AFBiz",
    buttons: [],
    params: [
      { param_name: "invoice_id", example: "INV-2026-0042" },
      { param_name: "amount", example: "N 4,500" },
      { param_name: "paid_date", example: "November 8, 2026" },
    ],
  },
} as const satisfies Record<string, TemplateBlueprint>;

export type AfbizTemplateName = keyof typeof AFBIZ_TEMPLATES;

export type SendBodyParam = { type: "text"; parameter_name: string; text: string };
export type SendButtonComponent = { type: "button"; sub_type: "url" | "quick_reply"; index: string; parameters: SendBodyParam[] };
export type SendBodyComponent = { type: "body"; parameters: SendBodyParam[] };
export type SendTemplateComponent = SendBodyComponent | SendButtonComponent;

export interface TemplateSendPayload {
  messaging_product: "whatsapp";
  recipient_type: "individual";
  to: string;
  type: "template";
  template: {
    name: AfbizTemplateName;
    language: { code: string };
    components: SendTemplateComponent[];
  };
}

const MAX_BODY = 1024;
const MAX_FOOTER = 60;
const MAX_BUTTON_LABEL = 25;

export function validateBlueprint(t: TemplateBlueprint): string | null {
  if (t.body.length > MAX_BODY) return `${t.name}: body ${t.body.length} > ${MAX_BODY}`;
  if (t.footer && t.footer.length > MAX_FOOTER) return `${t.name}: footer > ${MAX_FOOTER}`;
  for (const b of t.buttons) {
    if (b.text.length > MAX_BUTTON_LABEL) return `${t.name}: button "${b.text}" > ${MAX_BUTTON_LABEL}`;
    if (b.type === "url" && b.url && b.url.length > 2000) return `${t.name}: url > 2000`;
  }
  const nameCheck = /^[a-z0-9_]+$/;
  if (!nameCheck.test(t.name)) return `${t.name}: name has invalid characters (lowercase + underscores only)`;
  for (const p of t.params) {
    if (!nameCheck.test(p.param_name)) return `${t.name}: param "${p.param_name}" invalid`;
    if (p.example.length === 0) return `${t.name}: param "${p.param_name}" needs a nonzero example`;
  }
  return null;
}

export interface SendComponentResult {
  components: SendTemplateComponent[];
  buttonParams: Record<string, SendBodyParam[]>;
}

export function buildSendComponents(
  blueprint: TemplateBlueprint,
  values: Record<string, string>,
): SendComponentResult {
  const bodyParams: SendBodyParam[] = blueprint.params
    .filter((p) => values[p.param_name] !== undefined)
    .map((p) => ({ type: "text", parameter_name: p.param_name, text: values[p.param_name] ?? p.example }));

  const components: SendTemplateComponent[] = [{ type: "body", parameters: bodyParams }];
  const buttonParams: Record<string, SendBodyParam[]> = {};

  blueprint.buttons.forEach((btn, idx) => {
    const params: SendBodyParam[] = [];
    if (btn.type === "url" && btn.url?.includes("{{1}}")) {
      const urlParam = values["url_suffix"] ?? values["invoice_id"] ?? values["record_ref"] ?? "";
      params.push({ type: "text", parameter_name: "1", text: encodeURIComponent(urlParam) });
    }
    if (btn.type === "quick_reply") {
      params.push({ type: "text", parameter_name: "payload", text: values["payload"] ?? `${blueprint.name}:${idx}` });
    }
    buttonParams[String(idx)] = params;
    if (params.length > 0) {
      components.push({ type: "button", sub_type: btn.type as "url" | "quick_reply", index: String(idx), parameters: params });
    }
  });

  return { components, buttonParams };
}
