import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

/**
 * Le moteur ouvert (llama.cpp) : ce que la configuration doit savoir de lui
 * dès son chargement, sans rien importer du reste de la passerelle.
 *
 * Module feuille, comme commerceRegles.ts : config.ts le lit pour déclarer la
 * source de modèles, et un import de llamaCpp.ts depuis config.ts refermerait
 * un cycle (langue, pythonPrive, deployment), avec les erreurs d'ordre de
 * chargement déjà vues à la fusion du 28/09/2026.
 */

/**
 * Le moteur ouvert sert-il sur cette machine ?
 *
 *  - Mac à processeur Intel : oui, d'office. LM Studio n'y existe plus
 *    (engine.ts, relevé du 27/09/2026) et ces Mac restaient sans aucun modèle
 *    local ; demandé par Medhi le 28/09/2026 (« un moteur automatique pour
 *    les Mac Intel, avec llama.cpp : go »).
 *  - Ailleurs : seulement si `OXOAI_MOTEUR=llamacpp`, sur un système dont
 *    l'archive est épinglée (llamaCpp.ts). C'est ce qui a permis de
 *    l'essayer sur un Mac à puce Apple, où Rosetta n'était pas installée
 *    (le binaire Intel y refuse de démarrer, « Bad CPU type »).
 *
 * Quand il sert, LM Studio est coupé pour cette instance (config.ts) : deux
 * moteurs locaux se disputeraient la mémoire, et l'essai sur le Mac de Medhi
 * ne devait pas toucher à son LM Studio.
 */
export function moteurOuvert(): boolean {
  const voulu = (process.env.OXOAI_MOTEUR ?? "").trim().toLowerCase();
  if (voulu === "lmstudio") return false;
  if (process.platform !== "darwin") return false;
  if (voulu === "llamacpp") return process.arch === "x64" || process.arch === "arm64";
  return process.arch === "x64";
}

/** Le dossier du moteur ouvert : `<données>/llamacpp`. */
export const racineLlamaCpp = (): string =>
  join(process.env.OXOAI_DATA_DIR ?? join(homedir(), ".oxoai", "data"), "llamacpp");

/**
 * Port d'écoute du serveur, sur 127.0.0.1 seulement. 8795 : libre à côté de
 * la passerelle (8787), de LM Studio (1234) et des OpenClaw (18789, 18800).
 * `OXOAI_LLAMACPP_PORT` pour un autre, et pour les essais.
 */
export function portLlamaCpp(): number {
  const n = Number(process.env.OXOAI_LLAMACPP_PORT);
  return Number.isInteger(n) && n > 1024 && n < 65536 ? n : 8795;
}

export const urlLlamaCpp = (): string => `http://127.0.0.1:${portLlamaCpp()}/v1`;

/**
 * La clé que le serveur exige à chaque requête (`--api-key-file`).
 *
 * Sans elle, n'importe quel programme de la machine (une page web aussi, par
 * une requête vers 127.0.0.1) pourrait se servir du modèle, ou charger et
 * décharger des modèles par l'API du routeur. Tirée au hasard une fois,
 * gardée dans un fichier lisible par ce compte seul (0600), à côté du moteur.
 */
export function cleLlamaCpp(): string {
  const fichier = join(racineLlamaCpp(), "cle");
  try {
    const lue = readFileSync(fichier, "utf8").trim();
    if (/^[a-f0-9]{64}$/.test(lue)) return lue;
  } catch {
    /* pas encore tirée */
  }
  const cle = randomBytes(32).toString("hex");
  try {
    mkdirSync(racineLlamaCpp(), { recursive: true, mode: 0o700 });
    writeFileSync(fichier, `${cle}\n`, { mode: 0o600 });
    chmodSync(fichier, 0o600);
  } catch {
    /* dossier en lecture seule : le serveur ne démarrera pas, et l'écran le dira */
  }
  return cle;
}

export const fichierCleLlamaCpp = (): string => join(racineLlamaCpp(), "cle");

/** La clé existe-t-elle déjà (sans la tirer) ? */
export const cleLlamaCppPresente = (): boolean => existsSync(fichierCleLlamaCpp());

/* ── L'emplacement des modèles (28/09/2026) ─────────────────────────────── */

/*
 * Demandé par Medhi le 28/09/2026 : « il y a des gens dont le disque
 * principal n'a pas la place (ils ont un disque D: par exemple) ». Le moteur
 * lui-même (11 Mo) reste dans les données de l'instance ; les modèles (2 à
 * 18 Go chacun) vont là où l'administrateur l'a choisi (emplacementModeles.ts),
 * dans un sous-dossier à eux, jamais à la racine du dossier choisi : le ménage
 * du moteur (`menageLlama`) ne touche ainsi qu'à ce qu'il a posé.
 *
 * Ici, comme le reste de ce fichier, sans rien importer de la passerelle :
 * zonesProtegees.ts lit l'emplacement pour le fermer aux agents.
 */

/** Le nom du sous-dossier créé dans le dossier choisi. */
export const SOUS_DOSSIER_LLAMA = "modeles-llamacpp";

/** L'emplacement habituel des modèles : `<données>/llamacpp/modeles`. */
export const dossierModelesParDefaut = (): string => join(racineLlamaCpp(), "modeles");

/** Le fichier qui retient l'emplacement choisi, dans les données de l'instance (zone protégée). */
export const fichierEmplacementLlama = (): string => join(racineLlamaCpp(), "emplacement.json");

/**
 * L'emplacement choisi (le sous-dossier des modèles, chemin absolu), ou null
 * pour l'emplacement habituel. Un chemin relatif ou réseau écrit à la main
 * dans le fichier n'est pas suivi.
 */
export function emplacementLlamaChoisi(): string | null {
  try {
    const { dossier } = JSON.parse(readFileSync(fichierEmplacementLlama(), "utf8")) as { dossier?: unknown };
    if (typeof dossier === "string" && isAbsolute(dossier) && !/^[\\/]{2}/.test(dossier)) return dossier;
  } catch {
    /* pas de choix : l'emplacement habituel */
  }
  return null;
}

/** Le dossier des modèles du moteur ouvert : celui choisi, sinon l'emplacement habituel. */
export const dossierModelesLlama = (): string => emplacementLlamaChoisi() ?? dossierModelesParDefaut();

/**
 * Retient l'emplacement (null : l'emplacement habituel). Écrit à côté puis
 * renommé : un arrêt en pleine écriture ne laisse pas un fichier à moitié
 * écrit, qui renverrait les modèles vers l'emplacement habituel.
 */
export function ecrireEmplacementLlama(dossier: string | null): void {
  mkdirSync(racineLlamaCpp(), { recursive: true, mode: 0o700 });
  if (dossier === null) {
    rmSync(fichierEmplacementLlama(), { force: true });
    return;
  }
  const provisoire = `${fichierEmplacementLlama()}.${process.pid}.tmp`;
  writeFileSync(provisoire, `${JSON.stringify({ dossier, depuis: new Date().toISOString() })}\n`, { mode: 0o600 });
  renameSync(provisoire, fichierEmplacementLlama());
}
