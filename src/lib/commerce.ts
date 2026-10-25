import { apiFetch } from "./endpoint";
import { t, tf } from "@/lib/i18n";

/**
 * Stripe, Shopify, WooCommerce, Salesforce, Pipedrive et Zendesk
 * (gateway/src/natifs/commerce.ts, 28/09/2026). Une clé, un secret ou un jeton
 * ne revient jamais par ici : ils partent une fois, à l'enregistrement, et
 * l'instance les garde chiffrés.
 */

export type IdCommerce = "stripe" | "shopify" | "woocommerce" | "salesforce" | "pipedrive" | "zendesk";

export interface EtatCommerce {
  id: IdCommerce;
  nom: string;
  mode: "cle" | "identifiants" | "oauth";
  application: { disponible: boolean; identifiant?: string; adresse?: string; avecSecret?: boolean; bac?: boolean };
  lecture: string[];
  ecriture: string[] | null;
  retour: string;
  configure: boolean;
  compte?: string;
  accordes?: "ecriture"[];
  depuis?: string;
  aReconnecter: boolean;
  attente: boolean;
  issue?: { ok: boolean; message: string; quand: string };
  documentation: string[];
}

export interface EtatsCommerce {
  services: EtatCommerce[];
  administrateur: boolean;
}

export interface ResultatCommerce {
  ok: boolean;
  message: string;
  url?: string;
}

export async function etatCommerce(): Promise<EtatsCommerce | null> {
  try {
    const res = await apiFetch("/oxoai/commerce");
    if (!res.ok) return null;
    return (await res.json()) as EtatsCommerce;
  } catch {
    return null;
  }
}

async function poster(suite: string, corps: Record<string, unknown>): Promise<ResultatCommerce> {
  try {
    const res = await apiFetch(`/oxoai/commerce${suite}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(corps) });
    const json = (await res.json().catch(() => ({}))) as Partial<ResultatCommerce> & { error?: { message?: string } };
    if (json.error?.message) return { ok: false, message: json.error.message };
    return { ok: json.ok === true, message: json.message ?? tf("La demande a échoué ({0}).", res.status), url: typeof json.url === "string" ? json.url : undefined };
  } catch {
    return { ok: false, message: t("L'instance n'a pas répondu. Vérifiez qu'elle est démarrée, puis recommencez.") };
  }
}

/** Clé Stripe, clé WooCommerce, identifiants Shopify, ou application OAuth (Salesforce, Pipedrive, Zendesk). */
export const enregistrerCommerce = (service: IdCommerce, champs: { cle?: string; secret?: string; clientId?: string; adresse?: string; bac?: boolean }) => poster("/enregistrer", { service, ...champs });
export const connecterCommerce = (service: IdCommerce, ecriture: boolean) => poster("/connecter", { service, ecriture });
export const oublierCommerce = (service: IdCommerce, effacer = false) => poster("/oublier", { service, effacer });
