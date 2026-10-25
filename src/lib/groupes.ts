import { useCallback, useEffect, useState } from "react";
import { apiFetch } from "./endpoint";
import { retenirGroupes } from "./store/identity";
import { allAccounts } from "./store/accounts";
import { t } from "@/lib/i18n";

/**
 * Groupes de l'équipe (gateway/src/groupes.ts). Tenus par l'instance : c'est
 * elle qui vérifie qui peut les changer, et qui s'appuie sur eux pour décider
 * de ce que chacun voit.
 */

export interface Personne {
  id: string;
  nom: string;
  email: string;
  initiales: string;
}

/** Photo d'un collègue, prise dans la liste des comptes que ce poste tient déjà. */
export function photoDe(id: string): string | undefined {
  return allAccounts().find((a) => a.id === id)?.photo;
}

export interface Groupe {
  id: string;
  nom: string;
  description: string;
  membres: Personne[];
  responsables: string[];
  creePar: string;
  createdAt: string;
  updatedAt: string;
  estMembre: boolean;
  estResponsable: boolean;
}

async function lire<T>(res: Response): Promise<T> {
  const corps = (await res.json().catch(() => ({}))) as T & { error?: { message?: string } };
  if (!res.ok) throw new Error(corps.error?.message ?? t("L'instance n'a pas répondu."));
  return corps;
}

const poster = (chemin: string, corps: unknown) =>
  apiFetch(chemin, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(corps) });

export async function chargerGroupes(): Promise<{ groupes: Groupe[]; annuaire: Personne[] }> {
  return lire(await apiFetch("/oxoai/groupes"));
}

export async function creerGroupe(d: { nom: string; description: string; membres: string[] }): Promise<Groupe> {
  return (await lire<{ groupe: Groupe }>(await poster("/oxoai/groupes", d))).groupe;
}

export async function modifierGroupe(
  id: string,
  d: { nom?: string; description?: string; membres?: string[]; responsables?: string[] },
): Promise<Groupe> {
  return (await lire<{ groupe: Groupe }>(await poster(`/oxoai/groupes/${encodeURIComponent(id)}`, d))).groupe;
}

export async function quitterGroupe(id: string): Promise<void> {
  await lire(await poster(`/oxoai/groupes/${encodeURIComponent(id)}/quitter`, {}));
}

export async function supprimerGroupe(id: string): Promise<void> {
  await lire(await poster(`/oxoai/groupes/${encodeURIComponent(id)}/supprimer`, {}));
}

/** Les groupes et l'annuaire, rechargeables. `null` tant que rien n'est arrivé. */
export function useGroupes() {
  const [etat, setEtat] = useState<{ groupes: Groupe[]; annuaire: Personne[] } | null>(null);
  const [erreur, setErreur] = useState<string | null>(null);
  const recharger = useCallback(async () => {
    try {
      const e = await chargerGroupes();
      setEtat(e);
      retenirGroupes(e.groupes.filter((g) => g.estMembre).map((g) => g.id));
      setErreur(null);
    } catch (err) {
      setErreur(err instanceof Error ? err.message : String(err));
    }
  }, []);
  useEffect(() => {
    void recharger();
  }, [recharger]);
  return { etat, erreur, recharger };
}
