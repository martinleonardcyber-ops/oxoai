import { apiFetch } from "./endpoint";
import { t, tf } from "@/lib/i18n";

/**
 * Telegram, Discord et WhatsApp Business (gateway/src/natifs/messageries.ts).
 * Le jeton part une fois, à la connexion, et ne revient jamais par ici : l'état
 * ne dit que le compte, les réglages et les dates.
 */

export type IdMessagerie = "telegram" | "discord" | "whatsapp";

export interface EtatMessagerie {
  id: IdMessagerie;
  nom: string;
  configure: boolean;
  aReconnecter: boolean;
  compte?: string;
  depuis?: string;
  envoi?: boolean;
  conversations?: number;
  toutLeGroupe?: boolean;
  conflit?: string;
  contenu?: boolean;
  webhook?: { adresse: string; verification?: string; signature: boolean; dernier?: string };
  documentation: string[];
}

export interface EtatMessageries {
  services: EtatMessagerie[];
  administrateur: boolean;
  chiffrement: boolean;
}

export interface ResultatMessagerie {
  ok: boolean;
  message: string;
  etat?: EtatMessageries;
}

export async function etatMessageries(): Promise<EtatMessageries | null> {
  try {
    const res = await apiFetch("/oxoai/messageries");
    if (!res.ok) return null;
    return (await res.json()) as EtatMessageries;
  } catch {
    return null;
  }
}

async function poster(suite: string, corps: Record<string, unknown>): Promise<ResultatMessagerie> {
  try {
    const res = await apiFetch(`/oxoai/messageries${suite}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(corps) });
    const json = (await res.json().catch(() => ({}))) as Partial<ResultatMessagerie> & Partial<EtatMessageries> & { error?: { message?: string } };
    if (json.error?.message) return { ok: false, message: json.error.message };
    return {
      ok: json.ok === true,
      message: json.message ?? tf("La demande a échoué ({0}).", res.status),
      etat: Array.isArray(json.services) ? { services: json.services, administrateur: json.administrateur === true, chiffrement: json.chiffrement === true } : undefined,
    };
  } catch {
    return { ok: false, message: t("L'instance n'a pas répondu. Vérifiez qu'elle est démarrée, puis recommencez.") };
  }
}

export const connecterMessagerie = (corps: { service: IdMessagerie; jeton: string; envoi: boolean; numero?: string; compte?: string; secretApp?: string }) => poster("/connecter", corps);
export const reglerEnvoiMessagerie = (service: IdMessagerie, envoi: boolean) => poster("/envoi", { service, envoi });
export const oublierMessagerie = (service: IdMessagerie) => poster("/oublier", { service });
