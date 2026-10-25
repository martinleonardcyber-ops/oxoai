import { useCallback, useEffect, useState } from "react";
import {
  listerSessionsCode,
  retirerSessionCode,
  signalerSessionsCode,
  SESSIONS_CODE_CHANGEES,
  type SessionCodeResume,
} from "@/lib/code";
import { CODE_EN_COURS } from "./useCode";

/** Tant qu'une session travaille, la liste se relit à ce rythme : l'indicateur « en cours » s'éteint quand elle a fini. */
const RELECTURE_EN_COURS_MS = 5000;

/**
 * Les sessions de OxoAI Code de la personne connectée, séparées des Chats
 * (gateway/src/sessionsCode.ts). Relues à chaque changement signalé
 * (`signalerSessionsCode`) : ouverture, demande, retrait.
 *
 * Une liste qu'on n'a pas pu lire reste la précédente, avec l'erreur : elle ne
 * devient jamais vide par accident.
 */
export function useSessionsCode(actif = true) {
  const [sessions, setSessions] = useState<SessionCodeResume[]>([]);
  const [charge, setCharge] = useState(false);
  const [erreur, setErreur] = useState<string | undefined>();

  const relire = useCallback(() => {
    listerSessionsCode()
      .then((liste) => {
        setSessions(liste);
        setErreur(undefined);
      })
      .catch((err: unknown) => setErreur(err instanceof Error ? err.message : String(err)))
      .finally(() => setCharge(true));
  }, []);

  useEffect(() => {
    if (!actif) return;
    relire();
    window.addEventListener(SESSIONS_CODE_CHANGEES, relire);
    // Une session de cet écran commence ou finit de travailler : l'instance le dit aussi, on relit.
    window.addEventListener(CODE_EN_COURS, relire);
    return () => {
      window.removeEventListener(SESSIONS_CODE_CHANGEES, relire);
      window.removeEventListener(CODE_EN_COURS, relire);
    };
  }, [actif, relire]);

  /*
   * Une session travaille (d'après l'instance : l'agent, ou OxoAI qui prépare
   * ou contrôle) : on relit la liste de temps en temps, jusqu'à ce qu'elle ait
   * fini. Rien ne tourne quand aucune ne travaille.
   */
  const uneEnCours = sessions.some((s) => s.enCours);
  useEffect(() => {
    if (!actif || !uneEnCours) return;
    const minuterie = setInterval(relire, RELECTURE_EN_COURS_MS);
    return () => clearInterval(minuterie);
  }, [actif, uneEnCours, relire]);

  const retirer = useCallback(async (id: string) => {
    const ok = await retirerSessionCode(id);
    if (ok) signalerSessionsCode();
    return ok;
  }, []);

  return { sessions, charge, erreur, retirer };
}

/** Sessions rangées par dossier de projet, le dossier le plus récemment utilisé d'abord. */
export function parDossier(sessions: SessionCodeResume[]): { dossier: string; sessions: SessionCodeResume[] }[] {
  const groupes = new Map<string, SessionCodeResume[]>();
  for (const s of sessions) groupes.set(s.dossier, [...(groupes.get(s.dossier) ?? []), s]);
  return [...groupes.entries()]
    .map(([dossier, liste]) => ({ dossier, sessions: liste.sort((a, b) => b.maj.localeCompare(a.maj)) }))
    .sort((a, b) => b.sessions[0]!.maj.localeCompare(a.sessions[0]!.maj));
}
