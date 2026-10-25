import { useEffect } from "react";
import { features, branding } from "@/config/branding";
import { lireReglages, nomDuBot, passerelle, pontBot } from "@/lib/reunions";

/** Émis quand les réglages des réunions changent : le bot automatique suit. */
export const REGLAGES_REUNIONS = "oxoai:reglages-reunions";

/**
 * Bot automatique : si la personne l'a demandé, l'application de bureau
 * confie à son processus principal de quoi rejoindre les réunions Google Meet
 * de l'agenda, même fenêtre fermée. Rien dans un navigateur : le bot n'existe
 * que dans l'application de bureau.
 */
export function useBotAutomatique(): void {
  useEffect(() => {
    const pont = pontBot();
    if (!pont || !features.reunions) return;
    const appliquer = () => {
      void lireReglages()
        .then((r) => {
          const p = passerelle();
          return pont.automatique(r.botAuto && p ? { passerelle: p, nom: nomDuBot(r, branding.name) } : null);
        })
        .catch(() => undefined);
    };
    appliquer();
    window.addEventListener(REGLAGES_REUNIONS, appliquer);
    return () => window.removeEventListener(REGLAGES_REUNIONS, appliquer);
  }, []);
}
