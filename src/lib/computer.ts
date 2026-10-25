import { apiFetch } from "./endpoint";
import { ouvrirFlux } from "./flux";
import { t, tf } from "@/lib/i18n";

/**
 * Contrôle de l'écran, côté interface.
 *
 * L'agent ne touche à l'écran qu'avec l'accord d'un humain : la passerelle met
 * chaque action modifiante en attente et l'interface la présente. Sans cette
 * boucle, une erreur du modèle deviendrait une erreur sur le poste réel.
 */

export type ActionName =
  | "capture"
  | "deplacer"
  | "cliquer"
  | "double_cliquer"
  | "clic_droit"
  | "glisser"
  | "defiler"
  | "saisir"
  | "touche"
  | "ouvrir_app"
  | "attendre"
  | "enregistrer_document"
  | "saisir_tableau";

export interface Action {
  action: ActionName;
  x?: number;
  y?: number;
  x2?: number;
  y2?: number;
  texte?: string;
  touche?: string;
  direction?: "haut" | "bas" | "gauche" | "droite";
  lignes?: string[][];
  cellule?: string;
  quantite?: number;
}

export interface ModeleConseille {
  key: string;
  label: string;
  downloadGb: number;
  description: string;
}

export interface Capability {
  mode: "sandbox" | "hote" | "desactive";
  /** D'où vient le mode : profil de déploiement, choix fait dans l'interface, défaut. */
  source: "profil" | "interface" | "defaut";
  /** Le mode peut-il être changé depuis l'interface ; sinon, `raisonNonModifiable` dit pourquoi. */
  modifiable: boolean;
  raisonNonModifiable?: string;
  disponible: boolean;
  approbationRequise: boolean;
  ecran: { largeur: number; hauteur: number } | null;
  permissions: { capture: boolean; controle: boolean };
  /** Modèle qui lira les captures ; sans lui l'agent cliquerait à l'aveugle. */
  modeleEcran: string | null;
  modeleConseille: ModeleConseille | null;
  problemes: string[];
  enAttente: { id: string; action: Action; createdAt: number }[];
  /** Mode `sandbox` : le système de la machine de l'agent. */
  systeme?: "linux" | "macos";
  /** « Cet écran » : seulement quand l'instance tourne sur macOS (absent d'une instance plus ancienne : proposé, comme avant). */
  hotePossible?: boolean;
}

const INDISPONIBLE: Capability = {
  mode: "desactive",
  source: "defaut",
  modifiable: false,
  raisonNonModifiable: t("Passerelle injoignable."),
  disponible: false,
  approbationRequise: true,
  ecran: null,
  permissions: { capture: false, controle: false },
  modeleEcran: null,
  modeleConseille: null,
  problemes: [t("Passerelle injoignable.")],
  enAttente: [],
};

export async function capability(): Promise<Capability> {
  try {
    const res = await apiFetch("/oxoai/computer");
    if (!res.ok) return INDISPONIBLE;
    return (await res.json()) as Capability;
  } catch {
    return INDISPONIBLE;
  }
}

export interface ActionResult {
  ok: boolean;
  message: string;
  capture?: { base64: string; largeur: number; hauteur: number };
}

/**
 * Exécute une action directement, pour l'essai depuis les réglages.
 * Les coordonnées sont ici en points écran : c'est la boucle de l'agent, elle,
 * qui convertit celles que le modèle exprime dans le repère de sa capture.
 */
export async function runAction(action: Action): Promise<ActionResult> {
  try {
    const res = await apiFetch("/oxoai/computer/action", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(action),
    });
    return (await res.json()) as ActionResult;
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Active (`hote`, cette machine) ou désactive le contrôle de l'écran. Activer
 * exige le mot de passe, et le code si la double authentification est active :
 * l'instance refuse sinon. Lève une erreur au message lisible en cas de refus.
 */
export async function definirModeEcran(
  mode: "hote" | "sandbox" | "desactive",
  password?: string,
  code?: string,
  systeme?: "linux" | "macos",
): Promise<void> {
  const res = await apiFetch("/oxoai/computer/mode", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mode, password, code: code || undefined, systeme }),
  });
  if (!res.ok) {
    const corps = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
    throw new Error(corps.error?.message ?? t("L'instance n'a pas répondu."));
  }
}

/** Lance l'installation d'un modèle capable de lire l'écran. */
export async function installerModeleEcran(key?: string): Promise<boolean> {
  try {
    const res = await apiFetch("/oxoai/provision/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ role: "gui", model: key }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function answer(id: string, accord: boolean): Promise<boolean> {
  try {
    const res = await apiFetch("/oxoai/computer/approve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, accord }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export type ComputerEvent =
  | { type: "approbation_demandee"; id: string; action: Action }
  | { type: "approbation_resolue"; id: string; accord: boolean }
  | { type: "approbation_expiree"; id: string }
  | { type: "action_debut"; action: Action }
  | { type: "action_fin"; action: Action; ok: boolean; message: string };

/** S'abonne au flux des demandes et des actions. Renvoie de quoi se désabonner. */
export function subscribe(onEvent: (event: ComputerEvent) => void): () => void {
  return ouvrirFlux("/oxoai/computer/events", (donnees) =>
    onEvent(JSON.parse(donnees) as ComputerEvent),
  );
}

/** Sens de défilement, en phrase entière : « vers le {0} » donnait « vers le gauche ». */
const DEFILER: Record<NonNullable<Action["direction"]>, string> = {
  haut: t("Faire défiler vers le haut"),
  bas: t("Faire défiler vers le bas"),
  gauche: t("Faire défiler vers la gauche"),
  droite: t("Faire défiler vers la droite"),
};

/**
 * Description lisible d'une action, pour la demande d'approbation.
 *
 * Chaque branche passe par `t()` : la carte d'accord est la phrase la plus
 * importante de l'écran, et la moitié arrivait en français (« Cliquer en
 * (100, 200) ») au milieu d'une interface anglaise ou chinoise.
 */
export function describe(action: Action): string {
  const point = action.x !== undefined ? tf(" en ({0}, {1})", action.x, action.y) : "";
  switch (action.action) {
    case "capture":
      return t("Prendre une capture de l'écran");
    case "deplacer":
      return tf("Déplacer le curseur{0}", point);
    case "cliquer":
      return tf("Cliquer{0}", point);
    case "double_cliquer":
      return tf("Double-cliquer{0}", point);
    case "clic_droit":
      return tf("Faire un clic droit{0}", point);
    case "glisser":
      return tf("Glisser de ({0}, {1}) vers ({2}, {3})", action.x, action.y, action.x2, action.y2);
    case "defiler":
      return DEFILER[action.direction ?? "bas"] ?? DEFILER.bas;
    case "saisir":
      return tf("Saisir « {0} »", action.texte ?? "");
    case "touche":
      return tf("Envoyer la touche « {0} »", action.touche ?? "");
    case "ouvrir_app":
      return tf("Ouvrir l'application « {0} »", action.texte ?? "");
    case "attendre":
      return tf("Attendre {0} ms", action.quantite ?? 0);
    case "enregistrer_document":
      return tf("Enregistrer le document sous « {0} » dans le dossier d'échange", action.texte ?? "");
    case "saisir_tableau":
      return tf("Saisir un tableau de {0} ligne(s) dans le tableur", action.lignes?.length ?? 0);
    default:
      return t("Action inconnue");
  }
}

export const MODE_LABEL: Record<Capability["mode"], string> = {
  sandbox: t("Machine virtuelle"),
  hote: t("Cette machine"),
  desactive: t("Désactivé"),
};
