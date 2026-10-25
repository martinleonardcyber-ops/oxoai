import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles/index.css";
import App from "./App";
import { startSync } from "./lib/store/sync";
import { appliquerReprise, reprendreAnciensSecrets } from "./lib/coffre";
import { suivreModaliteSaisie } from "./lib/modaliteSaisie";

/*
 * Marque le document quand l'interface tourne dans la fenêtre native : les
 * commandes de fenêtre du système flottent alors au-dessus du contenu et la
 * mise en page doit leur réserver la place (voir .titlebar-inset).
 */
if (new URLSearchParams(window.location.search).has("desktop")) {
  document.documentElement.dataset.desktop = "1";
}
// macOS seulement : la barre de titre y est masquée (Windows et Linux gardent celle du système).
if (new URLSearchParams(window.location.search).get("titre") === "flottant") {
  document.documentElement.dataset.titre = "flottant";
}

// Le cadre de focus seulement au clavier (lib/modaliteSaisie.ts).
suivreModaliteSaisie();

/*
 * Déplace dans le trousseau du système ce qu'une version antérieure avait
 * laissé en clair dans le stockage du navigateur. Fait avant tout le reste :
 * la suite lit ces valeurs.
 */
reprendreAnciensSecrets(["oxoai:session-token", "oxoai:instance", "oxoai:identity:current"]);

/*
 * Et les préférences de l'ancienne origine `file://`, une seule fois : sans
 * cela, la mise à jour vers 0.22.0 aurait ramené le thème, les formats de date
 * et les réglages d'écran à leurs valeurs par défaut (voir lib/coffre.ts).
 */
appliquerReprise();

/*
 * Rejoint l'instance partagée si elle est joignable : les comptes, projets,
 * conversations et tâches deviennent alors communs à tous les postes. Sans
 * instance, l'application fonctionne sur son cache local.
 */
void startSync();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
