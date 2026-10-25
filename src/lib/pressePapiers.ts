/**
 * Copier du texte, pour tous les boutons « Copier » de l'application.
 *
 * Vu par Medhi le 27/09/2026 sur un PC Windows : « Copier les informations
 * techniques » ne faisait rien. Dans l'application de bureau, la page n'a pas
 * la permission du presse-papiers (electron/main.cjs la refuse, comme tout
 * sauf le micro) : `navigator.clipboard.writeText` échouait, et chaque bouton
 * avalait l'erreur à sa façon, parfois sans rien dire.
 *
 * D'où un seul chemin, dans cet ordre :
 *  1. l'application de bureau : le processus principal écrit et relit
 *     (electron/pressePapiers.cjs) ;
 *  2. le navigateur (développement, poste web) : `navigator.clipboard` ;
 *  3. en dernier recours, l'ancienne copie par sélection (`execCommand`),
 *     qui marche encore là où l'API moderne manque (origine non sécurisée).
 *
 * La réponse est un booléen honnête : `true` seulement si le texte a été
 * copié. Chaque bouton dit ensuite ce qui s'est passé, et jamais « Copié »
 * sur un échec.
 */

type Pont = {
  ecrire: (texte: string) => Promise<{ ok: boolean; motif?: string }>;
  vider: (texte: string) => Promise<{ ok: boolean; vide?: boolean; motif?: string }>;
};

function pont(): Pont | null {
  try {
    const p = (window as unknown as { oxoai?: { pressePapiers?: Partial<Pont> } }).oxoai?.pressePapiers;
    return p && typeof p.ecrire === "function" && typeof p.vider === "function" ? (p as Pont) : null;
  } catch {
    return null;
  }
}

/**
 * La copie par sélection d'un champ caché. Le focus revient ensuite où il
 * était : sans cela, une fenêtre (l'aide) perdait son élément actif, et le
 * clavier avec lui.
 */
function copierParSelection(texte: string): boolean {
  if (typeof document === "undefined" || typeof document.execCommand !== "function") return false;
  const actif = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const champ = document.createElement("textarea");
  champ.value = texte;
  champ.setAttribute("readonly", "");
  champ.setAttribute("aria-hidden", "true");
  champ.style.position = "fixed";
  champ.style.top = "0";
  champ.style.left = "0";
  champ.style.opacity = "0";
  champ.style.pointerEvents = "none";
  // Dans la fenêtre ouverte (l'aide), pas à la fin du document : un piège à focus la refuserait.
  (actif?.closest("[role=dialog]") ?? document.body).appendChild(champ);
  let ok = false;
  try {
    champ.focus();
    champ.select();
    ok = document.execCommand("copy");
  } catch {
    ok = false;
  } finally {
    champ.remove();
    actif?.focus();
  }
  return ok;
}

/** Copie `texte`. `true` seulement si c'est fait. */
export async function copierTexte(texte: string): Promise<boolean> {
  const p = pont();
  if (p) {
    try {
      if ((await p.ecrire(texte)).ok) return true;
    } catch {
      /* canal absent (processus principal d'une version antérieure) : on essaie la suite */
    }
  }
  try {
    if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(texte);
      return true;
    }
  } catch {
    /* refusé : dernier recours ci-dessous */
  }
  return copierParSelection(texte);
}

/**
 * Pour un secret copié (clé d'API) : vider le presse-papiers s'il le contient
 * encore.
 *  - `"vidé"` : il le contenait, il est vide ;
 *  - `"remplacé"` : il contient autre chose, on n'y a pas touché ;
 *  - `"impossible"` : on n'a pas pu savoir, rien n'a été vidé.
 *
 * Dans l'application de bureau, la page ne lit jamais le presse-papiers : le
 * processus principal compare, et ne vide que sa propre dernière copie.
 */
export async function viderSiContient(texte: string): Promise<"vidé" | "remplacé" | "impossible"> {
  const p = pont();
  if (p) {
    try {
      const r = await p.vider(texte);
      if (r.ok) return r.vide ? "vidé" : "remplacé";
    } catch {
      /* canal absent : on essaie le navigateur */
    }
  }
  try {
    if ((await navigator.clipboard.readText()) !== texte) return "remplacé";
    await navigator.clipboard.writeText("");
    return "vidé";
  } catch {
    return "impossible";
  }
}

/** Sélectionne le texte d'un élément, pour qu'un raccourci clavier finisse une copie refusée. */
export function selectionner(noeud: Node | null): void {
  const selection = typeof window !== "undefined" ? window.getSelection() : null;
  if (!noeud || !selection) return;
  const plage = document.createRange();
  plage.selectNodeContents(noeud);
  selection.removeAllRanges();
  selection.addRange(plage);
}
