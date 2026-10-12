import { execFile } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import { t, tf } from "./langue.ts";

/**
 * Roblox Studio, par le serveur MCP intégré à Studio (12/10/2026, demande de
 * Medhi).
 *
 * Lu le 12/10/2026 sur https://create.roblox.com/docs/studio/mcp : Studio sert
 * ses outils par un programme lancé en stdio, `StudioMCP`, rangé dans
 * l'application (macOS : `/Applications/RobloxStudio.app/Contents/MacOS/StudioMCP`)
 * ou par `%LOCALAPPDATA%\Roblox\mcp.bat` (Windows, par `cmd.exe /c`). Il faut
 * l'activer dans Studio : Assistant, « … », Manage MCP Servers, « Enable
 * Studio as MCP server ». Roblox Studio n'existe pas sous Linux. L'ancien
 * serveur `Roblox/studio-rust-mcp-server` (MIT) est archivé depuis avril 2026 :
 * Helix ne s'en sert pas.
 *
 * Rien n'est téléchargé : Helix lance le programme de l'installation de Studio
 * que la personne a faite elle-même, à son chemin fixe, jamais un chemin reçu
 * d'une requête ni relu du magasin. Sur macOS, sa signature est vérifiée avant
 * chaque lancement : signé par un certificat Developer ID d'Apple, et par la
 * même équipe que l'application Roblox Studio qui le contient (l'identifiant
 * d'équipe de Roblox n'a pas pu être relu ici, sans Studio : il n'est donc pas
 * écrit en dur, PROJET.md § 3.5). Sous Windows, le fichier de commandes est
 * dans le dossier de l'utilisateur, sans signature à lire : c'est le chemin
 * que donne Roblox, rien de plus (SECURITE.md § 65).
 */

const executer = promisify(execFile);

export const TELECHARGEMENT_ROBLOX = "https://create.roblox.com/docs/studio/setup";
export const DOCUMENTATION_ROBLOX = "https://create.roblox.com/docs/studio/mcp";

/*
 * Pour les essais seulement (scripts/essai-roblox-blender.mjs) :
 * `HELIX_ESSAI_ROBLOX_EXECUTABLE` (chemin absolu) remplace le programme et sa
 * vérification de signature (le faux serveur est un script Node). Posée par
 * qui lance la passerelle, jamais par une requête.
 */
const executableEssai = (): string | null => {
  const brut = process.env.HELIX_ESSAI_ROBLOX_EXECUTABLE;
  return brut && isAbsolute(brut) ? brut : null;
};

/** Roblox Studio tourne sur macOS et Windows : la fiche ne se montre que là. */
export const robloxProposable = (): boolean => process.platform === "darwin" || process.platform === "win32";

const appMac = (): string =>
  ["/Applications/RobloxStudio.app", join(homedir(), "Applications", "RobloxStudio.app")].find((c) => existsSync(c)) ?? "/Applications/RobloxStudio.app";
const batWindows = (): string => join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "Roblox", "mcp.bat");

/** La commande, toujours tirée des chemins que donne Roblox. */
export function commandeRoblox(): { command: string; args: string[] } {
  const essai = executableEssai();
  if (essai) return { command: essai, args: [] };
  if (process.platform === "win32") {
    return { command: join(process.env.SystemRoot ?? "C:\\Windows", "System32", "cmd.exe"), args: ["/c", batWindows()] };
  }
  return { command: join(appMac(), "Contents", "MacOS", "StudioMCP"), args: [] };
}

/** Signature vérifiée par fichier, tant qu'il ne change pas (taille, date). */
let signatureVue: { cle: string; ok: boolean } | null = null;

/** Exigence Developer ID d'Apple (certificat d'application et feuille Developer ID). */
const DEVELOPER_ID = "anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] exists and certificate leaf[field.1.2.840.113635.100.6.1.13] exists";

async function equipe(chemin: string): Promise<string | null> {
  try {
    const { stderr } = await executer("/usr/bin/codesign", ["-dv", chemin], { timeout: 15_000 });
    return stderr.split("\n").find((l) => l.startsWith("TeamIdentifier="))?.slice("TeamIdentifier=".length).trim() || null;
  } catch {
    return null;
  }
}

async function signatureMac(programme: string): Promise<boolean> {
  let cle = "";
  try {
    const s = statSync(programme);
    cle = `${programme}:${s.size}:${s.mtimeMs}:${s.ino}`;
  } catch {
    return false;
  }
  if (signatureVue?.cle === cle) return signatureVue.ok;
  let ok = false;
  try {
    await executer("/usr/bin/codesign", ["--verify", "--strict", `-R=${DEVELOPER_ID}`, programme], { timeout: 30_000 });
    const [deLui, deLApp] = await Promise.all([equipe(programme), equipe(appMac())]);
    ok = Boolean(deLui) && deLui !== "not set" && deLui === deLApp;
  } catch {
    ok = false;
  }
  signatureVue = { cle, ok };
  return ok;
}

/** Avant chaque lancement du serveur : `null` si tout va, sinon la raison, dans la langue de qui lit. */
export async function refusRoblox(): Promise<string | null> {
  if (!robloxProposable() && !executableEssai()) return t("Roblox Studio ne fonctionne que sous macOS et Windows : il ne peut pas tourner sur la machine de cette instance.");
  const essai = executableEssai();
  if (essai) return existsSync(essai) ? null : t("Roblox Studio est introuvable sur cette machine.");
  if (process.platform === "win32") {
    if (existsSync(batWindows())) return null;
    return tf("Le serveur MCP de Roblox Studio est introuvable sur cette machine ({0}). Installez Roblox Studio ({1}), ouvrez-le, puis activez son serveur MCP : Assistant, « … », Manage MCP Servers, « Enable Studio as MCP server ». Puis réessayez.", batWindows(), TELECHARGEMENT_ROBLOX);
  }
  if (!existsSync(appMac())) {
    return tf("Roblox Studio est introuvable sur cette machine. Installez-le ({0}) dans le dossier Applications, ouvrez-le, puis réessayez.", TELECHARGEMENT_ROBLOX);
  }
  const programme = commandeRoblox().command;
  if (!existsSync(programme)) {
    return t("Roblox Studio est installé, mais sans son serveur MCP (StudioMCP) : mettez Roblox Studio à jour, puis réessayez.");
  }
  if (!(await signatureMac(programme))) {
    return t("Le serveur MCP trouvé dans Roblox Studio n'est pas signé comme l'application Roblox Studio elle-même : rien n'a été lancé. Réinstallez Roblox Studio depuis son site officiel, puis réessayez.");
  }
  return null;
}

/**
 * Après le démarrage : un Studio répond-il ? `list_roblox_studios` (une
 * lecture) le dit. Le format exact de sa réponse n'a pas pu être lu ici, sans
 * Studio : on ne conclut à « aucun Studio » que sur un échec ou une liste
 * manifestement vide, et l'on donne alors le chemin pour activer le serveur.
 */
export function conseilRoblox(reponse: { ok: boolean; content: string } | null): string | null {
  const vide = !reponse || !reponse.ok || /^\s*(\[\s*\]|\{\s*\}|\(résultat vide\))?\s*$/.test(reponse.content) || /\bno (roblox )?studio|not connected|no instances?\b/i.test(reponse.content);
  return vide
    ? t("Aucun Roblox Studio ne répond pour l'instant. Ouvrez Roblox Studio et une place, puis activez son serveur MCP : Assistant, « … », Manage MCP Servers, « Enable Studio as MCP server » (un témoin vert le confirme).")
    : null;
}
