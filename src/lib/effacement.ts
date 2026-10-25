import { apiFetch } from "@/lib/endpoint";
import { t } from "@/lib/i18n";

/**
 * Suppression de son propre compte (RGPD, article 17). L'instance décide de
 * tout (`gateway/src/effacement.ts`) ; le poste montre d'abord ce qui
 * disparaîtra et ce qui sera confié à un collègue, puis relaie la confirmation.
 */

export interface Apercu {
  conversations: number;
  taches: number;
  agents: number;
  /** Agents qu'il a mis en service : retirés avec lui. */
  employes?: string[];
  /** Clés de modèles cloud qu'il a branchées. */
  clesModeles?: string[];
  /** Ses documents et dossiers de la bibliothèque. */
  bibliotheque?: { documents: number; dossiers: number };
  /** Ses réunions : comptes rendus, transcriptions, son. */
  reunions?: number;
  projetsSupprimes: string[];
  projetsConfies: { projet: string; a: string }[];
  mentionsRetirees: number;
  /** Un code sera demandé en plus du mot de passe. */
  deuxFacteurs: boolean;
}

async function lire<T>(res: Response): Promise<T> {
  const corps = (await res.json().catch(() => ({}))) as T & { error?: { message?: string } };
  if (!res.ok) throw new Error(corps.error?.message ?? t("L'instance n'a pas répondu."));
  return corps;
}

export const apercuEffacement = async (): Promise<Apercu> =>
  lire<Apercu>(await apiFetch("/oxoai/compte/effacement"));

export async function effacerMonCompte(password: string, code: string): Promise<void> {
  await lire(
    await apiFetch("/oxoai/compte/effacer", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password, code: code || undefined }),
    }),
  );
}

/**
 * Oublie sur ce poste ce qui restait de la personne : préférences d'écran
 * rangées sous son identifiant, séance, identité. Les données partagées se
 * resynchronisent seules depuis l'instance.
 */
export function oublierSurCePoste(userId: string): void {
  try {
    const cles: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const cle = localStorage.key(i);
      if (cle && cle.includes(userId)) cles.push(cle);
    }
    for (const cle of cles) localStorage.removeItem(cle);
  } catch {
    /* stockage indisponible : rien à oublier */
  }
}
