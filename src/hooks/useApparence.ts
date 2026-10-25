import { useCallback, useEffect, useState } from "react";
import {
  appliquer,
  ecrireMode,
  lireMode,
  programmer,
  resoudre,
  type ModeApparence,
  type Theme,
} from "@/lib/store/apparence";

/** Événement interne : garde tous les écrans d'accord sur l'apparence. */
const CHANGE = "oxoai:apparence-changee";

/**
 * Apparence courante et moyen d'en changer.
 *
 * Le thème est posé sur le document, jamais passé de composant en composant :
 * c'est un état de la fenêtre, pas une propriété d'un écran.
 */
export function useApparence() {
  const [mode, setMode] = useState<ModeApparence>(() => lireMode());
  const [theme, setTheme] = useState<Theme>(() => resoudre());

  // Applique, puis se reprogramme : au crépuscule, à l'aube, ou quand macOS
  // change d'avis. Le nettoyage annule le minuteur en cours.
  useEffect(() => {
    let vivant = true;
    let annuler = () => {};

    const poser = () => {
      if (!vivant) return;
      const resolu = resoudre(mode);
      appliquer(resolu);
      setTheme(resolu);
      annuler();
      annuler = programmer(mode, poser);
    };

    poser();
    return () => {
      vivant = false;
      annuler();
    };
  }, [mode]);

  useEffect(() => {
    const onChange = () => setMode(lireMode());
    window.addEventListener(CHANGE, onChange);
    return () => window.removeEventListener(CHANGE, onChange);
  }, []);

  const choisir = useCallback((suivant: ModeApparence) => {
    ecrireMode(suivant);
    setMode(suivant);
    window.dispatchEvent(new Event(CHANGE));
  }, []);

  /** Bascule immédiate, sans passer par les réglages. */
  const basculer = useCallback(() => {
    choisir(resoudre() === "sombre" ? "clair" : "sombre");
  }, [choisir]);

  return { mode, theme, choisir, basculer };
}
