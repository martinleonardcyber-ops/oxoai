import { branding } from "@/config/branding";
import { instance, isDesktopApp } from "@/lib/instance";
import { plateformePoste } from "@/lib/plateforme";
import { t, tf } from "@/lib/i18n";

/**
 * Signaler un problème (27/09/2026).
 *
 * Les retours doivent arriver à l'éditeur sans intermédiaire : soit un ticket
 * du dépôt public (GitHub prévient par mail ceux qui le suivent), soit un mail
 * à l'adresse de support de la marque. Dans les deux cas, c'est la personne
 * qui envoie, depuis son navigateur ou sa messagerie : l'application ne porte
 * **aucun jeton GitHub**. Le dépôt est public et l'application aussi ; un jeton
 * glissé dedans serait lisible par quiconque l'ouvre, et permettrait d'écrire
 * au nom de l'éditeur. D'où l'absence d'envoi en arrière-plan : on prépare, la
 * personne relit et envoie.
 *
 * Tout ce qui part est construit ici et montré à l'écran avant l'envoi : rien
 * n'est ajouté au dernier moment.
 */

/** Ce que la personne a écrit dans le formulaire. */
export interface Signalement {
  /** Ce qui ne va pas (obligatoire). */
  probleme: string;
  /** Ce qu'elle faisait à ce moment-là. */
  faisait: string;
  /** Ce qu'elle attendait. */
  attendait: string;
  /** Joindre les informations techniques (cochée par défaut). */
  avecTechnique: boolean;
}

/**
 * Au-delà, des navigateurs et des serveurs coupent l'adresse (GitHub refuse
 * vers 8 000 caractères). On garde une marge pour les redirections de
 * connexion, qui recopient l'adresse dans un paramètre `return_to`.
 */
export const LIMITE_ADRESSE = 7_500;

/**
 * Architecture du processeur, donnée par l'application de bureau depuis le
 * 27/09/2026 (preload.cjs). `null` dans un navigateur ou une version plus
 * ancienne : on ne devine pas, le choix reste à la personne sur GitHub.
 */
function architecture(): string | null {
  try {
    const a = (window as unknown as { oxoai?: { architecture?: unknown } }).oxoai?.architecture;
    return typeof a === "string" ? a : null;
  } catch {
    return null;
  }
}

/**
 * L'option du menu « System » du formulaire de ticket
 * (.github/ISSUE_TEMPLATE/bug_report.yml), quand on la connaît sans deviner.
 * Windows 10 et 11 ont le même agent utilisateur, et Linux ne dit pas s'il a
 * été installé par le paquet .deb ou l'AppImage : on ne choisit pas pour eux.
 */
export function systemeDuFormulaire(): string | null {
  const p = plateformePoste();
  const a = architecture();
  if (p === "darwin" && a === "arm64") return "macOS (Apple silicon)";
  if (p === "darwin" && a === "x64") return "macOS (Intel)";
  return null;
}

/** Nom lisible du système, pour les informations techniques. */
function systemeLisible(): string {
  const p = plateformePoste();
  const a = architecture();
  const nom = p === "darwin" ? "macOS" : p === "win32" ? "Windows" : p === "linux" ? "Linux" : null;
  if (nom) return a ? `${nom} (${a})` : nom;
  // Dans un navigateur : le nom du système seulement, lu dans l'agent utilisateur.
  const ua = navigator.userAgent;
  if (/Windows/.test(ua)) return "Windows";
  if (/Mac OS X|Macintosh/.test(ua)) return "macOS";
  if (/Linux/.test(ua)) return "Linux";
  return t("inconnu");
}

/**
 * Les informations techniques d'un signalement.
 *
 * Reprend ce que l'aide copie déjà (`Aide.tsx`), avec une différence : un
 * ticket GitHub est public, donc **l'adresse d'une instance d'entreprise n'y
 * figure pas** (seulement le fait que le poste y est rattaché). Aucun message,
 * aucun document, aucune clé, aucun nom : le modèle choisi est un identifiant
 * de modèle, pas un contenu.
 */
export function informationsSignalement(modele: string | undefined): string {
  const i = instance();
  return [
    `${branding.name} ${branding.version}`,
    tf("Cadre : {0}", isDesktopApp() ? t("application de bureau") : t("navigateur")),
    tf("Instance : {0}", i.remote ? t("instance d'entreprise (adresse non jointe)") : t("poste seul")),
    tf("Système : {0}", systemeLisible()),
    tf("Agent utilisateur : {0}", navigator.userAgent),
    tf("Langue : {0}", navigator.language),
    tf("Modèle choisi : {0}", modele?.trim() || t("aucun")),
    tf("Date : {0}", new Date().toISOString()),
  ].join("\n");
}

/** Première ligne du problème, bornée : c'est le titre du ticket et le sujet du mail. */
export function titreSignalement(s: Signalement): string {
  const ligne = s.probleme.trim().split(/\r?\n/)[0] ?? "";
  return ligne.length > 90 ? `${ligne.slice(0, 89).trimEnd()}…` : ligne;
}

/** Dépôt GitHub de la marque (`branding.urls.sourceCode`), ou null s'il n'est pas sur GitHub. */
export function depotGithub(): string | null {
  try {
    const u = new URL(branding.urls.sourceCode);
    const [proprietaire, depot] = u.pathname.split("/").filter(Boolean);
    if (u.protocol !== "https:" || u.hostname !== "github.com" || !proprietaire || !depot) return null;
    return `${proprietaire}/${depot.replace(/\.git$/, "")}`;
  } catch {
    return null;
  }
}

/** Marque posée à l'endroit où un texte a été coupé pour tenir dans l'adresse. */
function marqueCoupe(): string {
  return `\n${t("[…] (texte coupé : trop long pour tenir dans l'adresse)")}`;
}

/**
 * Coupe les champs les plus longs jusqu'à ce que l'adresse tienne.
 *
 * On coupe le texte d'origine, pas l'adresse encodée : couper au milieu d'un
 * « %C3%A9 » donnerait une adresse invalide. Une lettre accentuée prend six
 * caractères une fois encodée ; d'où la boucle, qui recalcule à chaque passe.
 */
function borner(
  champs: Record<string, string>,
  coupables: string[],
  construire: (c: Record<string, string>) => string,
): { adresse: string; tronque: boolean } {
  const c = { ...champs };
  let adresse = construire(c);
  let tronque = false;
  const marque = marqueCoupe();
  for (let passe = 0; adresse.length > LIMITE_ADRESSE && passe < 200; passe++) {
    const plusLong = coupables.reduce((a, b) => ((c[b] ?? "").length > (c[a] ?? "").length ? b : a));
    const texte = (c[plusLong] ?? "").replace(marque, "");
    if (texte.length === 0) break;
    const exces = adresse.length - LIMITE_ADRESSE;
    // Ce que pèse un caractère de ce texte une fois encodé : on coupe au plus juste (mesuré le 27/09/2026 : couper « exces / 3 » vidait un texte tout en accents).
    const poids = Math.max(1, encodeURIComponent(texte).length / texte.length);
    const garder = Math.max(0, texte.length - Math.max(20, Math.ceil(exces / poids)));
    c[plusLong] = texte.slice(0, garder).trimEnd() + marque;
    tronque = true;
    adresse = construire(c);
  }
  return { adresse, tronque };
}

/** Les champs du ticket, sous les noms `id` de bug_report.yml. */
function champsDuTicket(s: Signalement, technique: string | null): Record<string, string> {
  const probleme = s.probleme.trim();
  const attendait = s.attendait.trim();
  return {
    title: titreSignalement(s),
    version: branding.version,
    etapes: s.faisait.trim() || t("Non précisé."),
    attendu: [
      tf("Attendu : {0}", attendait || t("non précisé")),
      "",
      tf("Ce qui s'est passé : {0}", probleme),
    ].join("\n"),
    details: technique ?? t("Informations techniques non jointes."),
  };
}

/**
 * Adresse d'un nouveau ticket prérempli. Le formulaire de GitHub lit les
 * paramètres nommés comme les `id` de ses champs. La documentation de GitHub
 * ne le promet que pour les champs de texte : le menu « System » est passé
 * aussi quand on le connaît, sans garantie qu'il soit repris (non essayé).
 */
export function adresseTicket(s: Signalement, technique: string | null): { adresse: string; tronque: boolean } | null {
  const depot = depotGithub();
  if (!depot) return null;
  const systeme = systemeDuFormulaire();
  const construire = (c: Record<string, string>) => {
    const p = new URLSearchParams({ template: "bug_report.yml", ...c });
    if (systeme) p.set("systeme", systeme);
    return `https://github.com/${depot}/issues/new?${p.toString()}`;
  };
  return borner(champsDuTicket(s, technique), ["etapes", "attendu", "details"], construire);
}

/** Corps du mail, en clair : c'est aussi ce que l'écran montre avant l'envoi. */
function corpsDuMail(s: Signalement, technique: string | null): Record<string, string> {
  return {
    probleme: s.probleme.trim(),
    faisait: s.faisait.trim() || t("Non précisé."),
    attendait: s.attendait.trim() || t("Non précisé."),
    technique: technique ?? t("Informations techniques non jointes."),
  };
}

function assemblerMail(c: Record<string, string>): string {
  return [
    t("Ce qui ne va pas :"),
    c.probleme,
    "",
    t("Ce que je faisais :"),
    c.faisait,
    "",
    t("Ce que j'attendais :"),
    c.attendait,
    "",
    t("Informations techniques :"),
    c.technique,
  ].join("\n");
}

/**
 * Mail prérempli vers le support de la marque (`branding.urls.supportEmail`).
 * `encodeURIComponent` et non `URLSearchParams` : ce dernier écrit les espaces
 * en « + », que les messageries recopient tels quels dans le corps.
 */
export function adresseMail(s: Signalement, technique: string | null): { adresse: string; tronque: boolean; corps: string } {
  const sujet = tf("{0} {1}, signalement : {2}", branding.name, branding.version, titreSignalement(s));
  const construire = (c: Record<string, string>) =>
    `mailto:${branding.urls.supportEmail}?subject=${encodeURIComponent(sujet)}&body=${encodeURIComponent(assemblerMail(c))}`;
  const champs = corpsDuMail(s, technique);
  const r = borner(champs, ["probleme", "faisait", "attendait", "technique"], construire);
  // Le corps affiché est celui qui part, coupe comprise.
  const corps = decodeURIComponent(r.adresse.split("&body=")[1] ?? "");
  return { ...r, corps };
}

/**
 * Seules deux destinations sont admises depuis cet écran : un ticket du dépôt
 * sur github.com, et un mail. Le processus principal d'Electron fait sa propre
 * vérification (main.cjs) ; celle-ci empêche l'écran d'ouvrir autre chose,
 * même si une marque configurait une adresse inattendue.
 */
export function destinationAdmise(adresse: string): boolean {
  try {
    const u = new URL(adresse);
    if (u.protocol === "mailto:") return true;
    return u.protocol === "https:" && u.hostname === "github.com";
  } catch {
    return false;
  }
}

/**
 * Ouvre la destination hors de l'application : le navigateur du système pour
 * GitHub, la messagerie pour le mail.
 *
 * Dans l'application de bureau, `window.open` passe par `setWindowOpenHandler`
 * (electron/main.cjs), qui remet l'adresse au système (`shell.openExternal`).
 * Dans un navigateur, le ticket s'ouvre dans un nouvel onglet et le mail par
 * l'adresse de la page, comme un lien `mailto:` ordinaire.
 */
export function ouvrirDestination(adresse: string): boolean {
  if (!destinationAdmise(adresse)) return false;
  if (adresse.startsWith("mailto:") && !isDesktopApp()) {
    window.location.href = adresse;
    return true;
  }
  window.open(adresse, "_blank", "noopener,noreferrer");
  return true;
}
