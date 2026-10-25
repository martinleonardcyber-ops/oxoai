import { apiFetch } from "@/lib/endpoint";
import { branding } from "@/config/branding";
import { t } from "@/lib/i18n";

/**
 * Export RGPD : l'instance rassemble (`gateway/src/export.ts`), le poste
 * enregistre. Le fichier ne passe par aucun service : il va de l'instance au
 * disque de la personne, qui choisit où le ranger.
 */

export interface ResumeExport {
  conversations: number;
  projets: number;
  taches: number;
  entreesDeJournal: number;
  octets: number;
}

const nomDeFichier = () => {
  const marque =
    branding.name
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "export";
  const jour = new Date().toISOString().slice(0, 10);
  return `${marque}-mes-donnees-${jour}.json`;
};

export async function telechargerMesDonnees(): Promise<ResumeExport> {
  const res = await apiFetch("/oxoai/export");
  if (!res.ok) {
    const corps = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
    throw new Error(corps.error?.message ?? t("L'export a échoué."));
  }
  const donnees = (await res.json()) as {
    conversations?: unknown[];
    projets?: unknown[];
    taches?: unknown[];
    journal?: unknown[];
  };
  const texte = JSON.stringify(donnees, null, 2);
  const fichier = new Blob([texte], { type: "application/json" });
  const adresse = URL.createObjectURL(fichier);
  const lien = document.createElement("a");
  lien.href = adresse;
  lien.download = nomDeFichier();
  document.body.appendChild(lien);
  lien.click();
  lien.remove();
  // Laisse au navigateur le temps de lire le fichier avant de le libérer.
  setTimeout(() => URL.revokeObjectURL(adresse), 60_000);
  return {
    conversations: donnees.conversations?.length ?? 0,
    projets: donnees.projets?.length ?? 0,
    taches: donnees.taches?.length ?? 0,
    entreesDeJournal: donnees.journal?.length ?? 0,
    octets: fichier.size,
  };
}
