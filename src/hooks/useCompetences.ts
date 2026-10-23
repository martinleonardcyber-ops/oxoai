import { useCallback, useEffect, useState } from "react";
import { currentUser } from "@/lib/store/identity";
import {
  allumeePour,
  basculerPourMoi,
  competencesVisibles,
  creerCompetence,
  modifierCompetence,
  supprimerCompetence,
  type Competence,
  type DonneesCompetence,
} from "@/lib/store/competences";

const CHANGE = "helix:competences-changed";
/** L'interrupteur personnel d'une compétence partagée vit dans le profil. */
const PROFIL = "helix:profile-changed";

function prevenir(): void {
  window.dispatchEvent(new Event(CHANGE));
}

/**
 * Compétences visibles, et ce qu'on peut en faire.
 *
 * Le même événement sert aux écritures locales et à la synchronisation
 * (`sync.ts`) : une compétence écrite par un collègue sur un autre poste
 * rafraîchit cet écran sans qu'il ait à savoir d'où elle vient.
 *
 * Depuis le 23/10/2026, l'écran n'en tire plus de consignes : l'instance les
 * ajoute elle-même à chaque demande (gateway/src/competences.ts).
 */
export function useCompetences() {
  const [liste, setListe] = useState<Competence[]>(() => competencesVisibles(currentUser()));
  const [, setTour] = useState(0);

  const relire = useCallback(() => {
    setListe(competencesVisibles(currentUser()));
    setTour((n) => n + 1);
  }, []);

  useEffect(() => {
    window.addEventListener(CHANGE, relire);
    window.addEventListener(PROFIL, relire);
    return () => {
      window.removeEventListener(CHANGE, relire);
      window.removeEventListener(PROFIL, relire);
    };
  }, [relire]);

  const creer = useCallback((donnees: DonneesCompetence) => {
    const c = creerCompetence(currentUser(), donnees);
    prevenir();
    return c;
  }, []);

  const modifier = useCallback((id: string, changements: Partial<Competence>) => {
    modifierCompetence(id, changements);
    prevenir();
  }, []);

  const supprimer = useCallback((id: string) => {
    supprimerCompetence(id);
    prevenir();
  }, []);

  /** Allumée pour la personne de la séance (la sienne : son interrupteur ; celle d'un collègue : le sien aussi). */
  const allumee = useCallback((c: Competence) => allumeePour(c, currentUser()), []);
  const basculer = useCallback((c: Competence, allumer: boolean) => {
    basculerPourMoi(c, currentUser(), allumer);
    prevenir();
  }, []);

  const moi = currentUser().id;
  return { competences: liste, creer, modifier, supprimer, relire, allumee, basculer, moi };
}
