/**
 * Le presse-papiers, écrit par le processus principal.
 *
 * Vu par Medhi le 27/09/2026 sur un PC Windows (2026.927.3) : « Copier les
 * informations techniques » ne faisait rien. Cause : la page copiait par
 * `navigator.clipboard.writeText`, que Chromium soumet à la permission
 * `clipboard-sanitized-write` ; or la fenêtre refuse d'office toute
 * permission sauf le micro (main.cjs, `setPermissionCheckHandler`), et la
 * promesse rejetée était avalée sans rien dire. Le défaut valait sur les
 * trois systèmes et pour tous les boutons « Copier ».
 *
 * Plutôt que d'ouvrir une permission du navigateur, deux canaux étroits :
 *
 *  - `oxoai:presse-papiers-ecrire` : du texte, rien d'autre (ni image, ni
 *    HTML, ni fichier), borné en taille, relu aussitôt pour ne répondre
 *    « copié » que si c'est vrai ;
 *  - `oxoai:presse-papiers-vider` : pour une clé d'API, vider le
 *    presse-papiers s'il contient encore **ce que OxoAI y a mis lui-même** en
 *    dernier. La page ne lit jamais le presse-papiers : elle ne peut ni en
 *    tirer ce que la personne a copié ailleurs, ni s'en servir pour deviner
 *    son contenu, ni effacer autre chose que sa propre copie.
 *
 * Les deux vérifient, comme les autres canaux, que l'appel vient de la
 * fenêtre de l'application (`depuisLaFenetre`).
 *
 * Depuis Electron 44, `readText` et `writeText` du processus principal
 * renvoient une promesse (electron.d.ts). Sans `await`, la relecture
 * comparait une promesse à du texte : essai du 27/09/2026 dans Electron même.
 */

/**
 * Deux millions de caractères : de quoi porter la transcription d'une longue
 * réunion (deux heures font environ 150 000 caractères), pas de quoi faire
 * passer n'importe quoi par le processus principal.
 */
const TAILLE_MAX = 2_000_000;

/** Windows peut rendre des fins de ligne `\r\n` là où l'on a écrit `\n`. */
const memeTexte = (a, b) => a.replace(/\r\n/g, "\n") === b.replace(/\r\n/g, "\n");

/**
 * @param {{ ipcMain: import("electron").IpcMain, clipboard: import("electron").Clipboard, depuisLaFenetre: (event: unknown) => boolean }} options
 */
function installerPressePapiers({ ipcMain, clipboard, depuisLaFenetre }) {
  /** Le dernier texte écrit par ce canal, seul que `vider` accepte d'effacer. */
  let dernierEcrit = null;

  ipcMain.handle("oxoai:presse-papiers-ecrire", async (event, texte) => {
    if (!depuisLaFenetre(event)) throw new Error("Refusé.");
    if (typeof texte !== "string") return { ok: false, motif: "invalide" };
    if (texte.length > TAILLE_MAX) return { ok: false, motif: "trop long" };
    try {
      await clipboard.writeText(texte);
      // Relu : un presse-papiers tenu par un autre programme (Windows) ou absent (Linux sans session graphique) échoue sans lever d'erreur.
      if (!memeTexte(String(await clipboard.readText()), texte)) return { ok: false, motif: "non relu" };
    } catch {
      return { ok: false, motif: "système" };
    }
    dernierEcrit = texte;
    return { ok: true };
  });

  ipcMain.handle("oxoai:presse-papiers-vider", async (event, texte) => {
    if (!depuisLaFenetre(event)) throw new Error("Refusé.");
    if (typeof texte !== "string" || texte === "" || texte.length > TAILLE_MAX) return { ok: false, motif: "invalide" };
    // Autre chose que la dernière copie de OxoAI : on n'y touche pas, et on ne dit pas ce qu'il y a.
    if (dernierEcrit === null || texte !== dernierEcrit) return { ok: true, vide: false };
    try {
      if (!memeTexte(String(await clipboard.readText()), texte)) {
        // Remplacé depuis par la personne : ce n'est plus à OxoAI de le vider.
        dernierEcrit = null;
        return { ok: true, vide: false };
      }
      // Une autre copie de OxoAI, faite pendant la relecture, n'est pas effacée à sa place.
      if (dernierEcrit !== texte) return { ok: true, vide: false };
      await clipboard.clear();
      dernierEcrit = null;
      return { ok: true, vide: true };
    } catch {
      return { ok: false, motif: "système" };
    }
  });
}

module.exports = { installerPressePapiers, TAILLE_MAX };
