import { execFile } from "node:child_process";
import { basename, isAbsolute } from "node:path";
import { promisify } from "node:util";
import { ecouteurs, executableParLsof, identite, processusOuvert, reel, type Ecouteur } from "./ecouteurs.ts";
import { t, tf } from "./langue.ts";
import type { VerdictEcouteur } from "./palmier.ts";

/**
 * Unreal Editor, par son serveur MCP officiel (16/10/2026, demande de Medhi :
 * un connecteur Unreal Engine).
 *
 * Lu le 16/10/2026 sur la page d'Epic « Unreal MCP in Unreal Editor »
 * (https://dev.epicgames.com/documentation/unreal-engine/unreal-mcp-in-unreal-editor) :
 *  - le plugin `ModelContextProtocol`, nommé « Unreal MCP » dans le
 *    navigateur de plugins, **expérimental**, livré avec Unreal Engine 5.8 ;
 *    ses outils viennent du plugin « All Toolsets » (sans lui, aucun) ;
 *  - un serveur MCP **dans le processus de l'éditeur**, en HTTP sur la boucle
 *    locale : `http://127.0.0.1:8000/mcp` par défaut (« Server Port Number »
 *    et « Server URL Path » dans Editor Preferences), transport « Streamable
 *    HTTP » pour un client ;
 *  - démarré par « Auto Start Server » (éteint par défaut) ou la commande de
 *    console `ModelContextProtocol.StartServer` ;
 *  - **sans authentification**, sur la boucle seulement, en-tête `Origin`
 *    non local refusé ;
 *  - les outils s'exécutent un par un sur le fil du jeu : les appels ne se
 *    superposent pas (mcp.ts, `serie`).
 *
 * Helix ne télécharge ni ne distribue rien : il parle à l'éditeur que la
 * personne a installé et ouvert. Comme pour Palmier Pro et Blender, un port
 * sans authentification peut être pris par n'importe quel programme de la
 * machine (le 8000 est aussi celui de nombreux serveurs de développement) :
 * le programme qui écoute est **reconnu** avant chaque requête.
 *  - Son exécutable doit être celui de l'éditeur : `UnrealEditor` dans
 *    `UnrealEditor.app/Contents/MacOS/` sur macOS, `UnrealEditor.exe` sous
 *    Windows, `UnrealEditor` sous Linux.
 *  - Signé, sa signature doit être valide (macOS : `codesign --verify` du
 *    processus en cours ; Windows : Authenticode « Valid », au nom d'Epic
 *    Games). Une signature invalide, ou au nom d'un autre éditeur : refus.
 *  - Non signé, il est accepté sur son nom seul : un éditeur compilé depuis
 *    les sources d'Epic n'est pas signé. C'est plus faible que Blender
 *    (signature exigée) et c'est dit dans SECURITE.md § 66 : un programme
 *    local non signé nommé `UnrealEditor` qui prend le port recevrait les
 *    demandes de l'agent. L'équipe Apple d'Epic n'est pas épinglée : elle n'a
 *    pas été relue sur un binaire (aucun Unreal Engine sur la machine de
 *    travail), et l'écrire de mémoire ferait refuser l'éditeur de tous.
 */

const executer = promisify(execFile);

/** Le port par défaut du serveur (« Server Port Number »). */
export const PORT_UNREAL = 8000;
export const CHEMIN_UNREAL = "/mcp";
export const TELECHARGEMENT_UNREAL = "https://www.unrealengine.com/download";
export const DOCUMENTATION_UNREAL = "https://dev.epicgames.com/documentation/unreal-engine/unreal-mcp-in-unreal-editor";

/*
 * Pour les essais seulement (scripts/essai-roblox-blender.mjs, partie D),
 * posées par qui lance la passerelle, jamais par une requête :
 *  - `HELIX_ESSAI_UNREAL_PORT` : le port du faux éditeur ;
 *  - `HELIX_ESSAI_UNREAL_EXECUTABLE` (chemin absolu) : l'exécutable qui doit
 *    écouter, à la place du nom et de la signature (le faux est un script Node).
 */
export function portUnreal(): number {
  const essai = Number(process.env.HELIX_ESSAI_UNREAL_PORT);
  return Number.isInteger(essai) && essai >= 1024 && essai <= 65535 ? essai : PORT_UNREAL;
}
const executableEssai = (): string | null => {
  const v = process.env.HELIX_ESSAI_UNREAL_EXECUTABLE;
  return v && isAbsolute(v) ? v : null;
};

/** Unreal Editor tourne sur macOS, Windows et Linux. */
export const unrealProposable = (): boolean => ["darwin", "win32", "linux"].includes(process.platform);

/** Le nom de l'exécutable de l'éditeur, selon le système. */
export function estExecutableUnreal(chemin: string, systeme: NodeJS.Platform = process.platform): boolean {
  if (systeme === "win32") return /^UnrealEditor\.exe$/i.test(basename(chemin.replace(/\\/g, "/")));
  if (systeme === "darwin") return /\/UnrealEditor\.app\/Contents\/MacOS\/UnrealEditor$/.test(chemin) && !chemin.includes("/../");
  return basename(chemin) === "UnrealEditor";
}

/**
 * Windows : signature Authenticode acceptée ? Valide au nom d'Epic Games, ou
 * absente (éditeur compilé depuis les sources) ; tout autre état refusé.
 */
export function signatureWindowsAcceptee(signature: { statut: string; sujet: string } | undefined): boolean {
  if (!signature) return false;
  if (signature.statut === "NotSigned") return true;
  return signature.statut === "Valid" && /Epic Games/i.test(signature.sujet);
}

const reconnus = new Map<number, string>();

/** Ce processus est-il Unreal Editor ? Son exécutable si oui, `null` sinon. */
async function estUnreal(e: Ecouteur): Promise<string | null> {
  const essai = executableEssai();
  if (essai) {
    let lu = e.exe;
    if (!lu && process.platform === "darwin") lu = await executableParLsof(e.pid).catch(() => null);
    return lu && reel(lu) === reel(essai) ? lu : null;
  }
  if (process.platform === "darwin") {
    const exe = await executableParLsof(e.pid).catch(() => null);
    if (!exe || !estExecutableUnreal(exe, "darwin")) return null;
    try {
      await executer("/usr/bin/codesign", ["--verify", String(e.pid)], { timeout: 15_000 });
      return exe;
    } catch (err) {
      // Non signé (compilé depuis les sources) : accepté sur son nom ; une signature présente mais invalide : refus.
      return /not signed at all/i.test(String((err as { stderr?: string }).stderr ?? "")) ? exe : null;
    }
  }
  if (process.platform === "win32") return e.exe && estExecutableUnreal(e.exe, "win32") && signatureWindowsAcceptee(e.signature) ? e.exe : null;
  return e.exe && estExecutableUnreal(e.exe, "linux") ? e.exe : null;
}

/** Le message quand personne n'écoute : l'éditeur fermé, ou ouvert sans son serveur. */
async function messageAbsent(port: number): Promise<string> {
  const ouvert = executableEssai() ? null : await processusOuvert({ mac: "UnrealEditor", windows: "UnrealEditor.exe", linux: /^UnrealEditor$/ });
  const marche = tf(
    "Dans Unreal Editor 5.8 ou plus récent : Edit, Plugins, activez « Unreal MCP » et « All Toolsets », redémarrez l'éditeur, puis démarrez le serveur : Edit, Editor Preferences, General, Model Context Protocol, cochez « Auto Start Server », ou tapez ModelContextProtocol.StartServer dans la console. Gardez le port {0} (« Server Port Number »). Puis réessayez.",
    port,
  );
  if (ouvert === false) return `${tf("Unreal Editor n'est pas ouvert sur cette machine. Ouvrez votre projet dans Unreal Editor (pas encore installé ? {0}).", TELECHARGEMENT_UNREAL)} ${marche}`;
  if (ouvert === true) return `${tf("Unreal Editor est ouvert, mais son serveur MCP ne répond pas sur le port {0} : le plugin « Unreal MCP » n'est pas actif, ou son serveur n'est pas démarré.", port)} ${marche}`;
  return `${tf("Unreal Editor ne répond pas sur le port de son serveur MCP ({0}) : l'éditeur est fermé, ou son serveur n'est pas démarré.", port)} ${marche}`;
}

/**
 * Le programme qui écoute sur le port du serveur est-il Unreal Editor ? Rien
 * n'est envoyé au port tant que la réponse n'est pas oui (mcp.ts, `local`).
 */
export async function ecouteurUnreal(port = portUnreal()): Promise<VerdictEcouteur> {
  let liste: Ecouteur[];
  try {
    liste = await ecouteurs(port);
  } catch {
    return { ok: false, raison: "illisible", message: tf("Impossible de savoir quel programme écoute sur le port du serveur MCP d'Unreal Editor ({0}) : rien ne lui a été envoyé.", port) };
  }
  for (const pid of [...reconnus.keys()]) if (!liste.some((e) => e.pid === pid)) reconnus.delete(pid);
  if (liste.length === 0) return { ok: false, raison: "absent", message: await messageAbsent(port) };
  for (const e of liste) {
    const qui = await identite(e);
    if (qui && reconnus.get(e.pid) === qui) continue;
    reconnus.delete(e.pid);
    if (!(await estUnreal(e))) {
      return { ok: false, raison: "autre", message: tf("Un autre programme occupe le port du serveur MCP d'Unreal Editor ({0}) sur cette machine : ce n'est pas Unreal Editor, et rien ne lui a été envoyé. Fermez ce programme (le port {0} sert aussi à bien des serveurs de développement), ou choisissez un autre port dans Unreal Editor et laissez celui-ci libre, puis réessayez.", port) };
    }
    if (qui) reconnus.set(e.pid, qui);
  }
  return { ok: true, pid: liste[0]!.pid };
}

/**
 * Après le branchement : l'éditeur a-t-il des jeux d'outils ? Sans le plugin
 * « All Toolsets », le serveur répond mais n'a rien à proposer (page d'Epic).
 * La forme exacte de la réponse de `list_toolsets` n'est pas documentée : une
 * réponse vide ou sans aucun nom est lue comme « aucun jeu ».
 */
export function conseilUnreal(reponse: { ok: boolean; content: string } | null, nombreOutils: number): string | null {
  const vide = (texte: string) => {
    const brut = texte.trim();
    if (!brut || brut === "[]" || brut === "{}" || brut === "(résultat vide)") return true;
    try {
      const j = JSON.parse(brut) as unknown;
      const liste = Array.isArray(j) ? j : j && typeof j === "object" ? Object.values(j as Record<string, unknown>).find(Array.isArray) : null;
      return Array.isArray(liste) && liste.length === 0;
    } catch {
      return false;
    }
  };
  if (nombreOutils === 0 || (reponse && reponse.ok && vide(reponse.content))) {
    return t("Unreal Editor ne propose encore aucun outil : activez aussi le plugin « All Toolsets » (Edit, Plugins), redémarrez l'éditeur, puis « Réessayer ».");
  }
  return null;
}
