import { useCallback, useEffect, useState } from "react";
import { diagnostic as lireDiagnostic, type Diagnostic } from "@/lib/atelier";

/** Signal interne : l'atelier vient de changer d'état après une préparation. */
export const ATELIER_CHANGE = "oxoai:atelier-change";

/**
 * État de l'atelier bureautique, pour les écrans qui en dépendent.
 *
 * Cowork s'en sert pour deux choses : décider s'il annonce au modèle qu'il
 * peut produire des documents, et afficher la préparation. Annoncer des
 * capacités absentes serait pire que de se taire : le modèle s'acharnerait
 * sur des outils qui n'existent pas.
 */
export function useAtelier() {
  const [diagnostic, setDiagnostic] = useState<Diagnostic | null>(null);

  const relire = useCallback(() => {
    void lireDiagnostic()
      .then(setDiagnostic)
      .catch(() => setDiagnostic(null));
  }, []);

  useEffect(() => {
    relire();
    window.addEventListener(ATELIER_CHANGE, relire);
    return () => window.removeEventListener(ATELIER_CHANGE, relire);
  }, [relire]);

  return { diagnostic, pret: diagnostic?.pret ?? false, relire };
}
