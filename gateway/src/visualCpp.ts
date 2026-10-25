import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { createReadStream, createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join, win32 } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { t, tf } from "./langue.ts";

/**
 * Les bibliothèques Visual C++ de Microsoft, posées par OxoAI sous Windows
 * quand elles manquent.
 *
 * Décidé par Medhi le 29/09/2026 : exception à la règle des licences (Apache
 * 2.0 et MIT seulement), comme Python (pythonPrive.ts) et Unsloth avant lui
 * (PROJET.md § 3.9 et § 3.12). Le paquet « Microsoft Visual C++
 * Redistributable » est sous licence de Microsoft (logiciel fermé, gratuit,
 * redistribuable) ; OxoAI ne le livre pas, il le télécharge chez Microsoft au
 * moment d'installer, et c'est Windows qui l'installe, avec l'autorisation
 * d'administrateur de la personne (UAC).
 *
 * Pourquoi : deux modules natifs d'OpenClaw 2026.9.4, écrits en Rust et
 * compilés avec la bibliothèque d'exécution de Microsoft, importent
 * `VCRUNTIME140.dll` (relevé dans leur table d'import sur les Windows de
 * GitHub le 29/09/2026, PROJET.md § 3.4) :
 * `@openclaw/fs-safe-win32-x64-msvc` (x64 seulement : pas de paquet arm64) et
 * `@ubjs/node-win32-{x64,arm64}-msvc`. Les autres DLL qu'ils importent
 * (`api-ms-win-crt-*`, la CRT universelle) font partie de Windows 10 et 11 ;
 * `node.exe` n'importe rien du Visual C++ (bibliothèque liée statiquement),
 * ni les autres modules natifs. Ni `MSVCP140.dll` ni `VCRUNTIME140_1.dll`.
 * La DLL est là sur les machines de GitHub (Visual Studio y est installé) et
 * sur la plupart des PC (beaucoup de programmes l'installent), mais pas sur
 * tous. Vu sur GitHub le 29/09/2026, la DLL retirée de System32 le temps de
 * l'essai, avec le PATH que OxoAI donne à OpenClaw : `openclaw --version`
 * répond et la passerelle d'OpenClaw ouvre son port, mais les deux modules
 * ne se chargent plus ; ce qui s'en sert échoue alors en cours de route.
 *
 * Ce qui est épinglé ici, et nulle part ailleurs : l'adresse **versionnée** de
 * chaque paquet sur download.visualstudio.microsoft.com (celle vers laquelle
 * le lien permanent de Microsoft, aka.ms/vc14/vc_redist.<arch>.exe, menait le
 * 29/09/2026 : jamais le lien permanent lui-même, qui change de fichier sans
 * prévenir), sa taille, son empreinte SHA-256, et le signataire attendu. Rien
 * ne vient d'une requête ni du profil. Le fichier est vérifié (taille,
 * empreinte, signature Authenticode de Microsoft jusqu'à une racine de
 * Microsoft), puis relu et revérifié juste avant d'être lancé, du dossier où
 * il a été vérifié. Voir SECURITE.md § 64.
 *
 * Aucune de ces fonctions pures ne lit `process.platform` : un Mac les essaie
 * telles que Windows les verra (scripts/essai-openclaw-windows.mjs, section H).
 */

/** La page officielle de Microsoft, donnée à la personne quand elle doit l'installer elle-même. */
export const PAGE_VISUAL_CPP = "https://learn.microsoft.com/cpp/windows/latest-supported-vc-redist";

export type ArchVisualCpp = "x64" | "arm64";

export interface PaquetVisualCpp {
  arch: ArchVisualCpp;
  /** Version du paquet (propriété « version du produit » du fichier), relevée le 29/09/2026. */
  version: string;
  adresse: string;
  octets: number;
  sha256: string;
}

/*
 * Relevés le 29/09/2026 : adresse de destination du lien permanent de
 * Microsoft (aka.ms/vc14 → aka.ms/vs/18/release → download.visualstudio.
 * microsoft.com), taille annoncée par le serveur ; empreinte, taille, version
 * du produit et signature lues sur le fichier téléchargé par les machines
 * Windows x64 et arm64 de GitHub (essai-openclaw-windows.yml,
 * `releve-visual-cpp.json` en artefact). Le nom de dossier qui précède le
 * fichier dans l'adresse est son empreinte SHA-256, en majuscules : Microsoft
 * l'écrit lui-même, et c'est bien celle du fichier.
 */
export const PAQUETS_VISUAL_CPP: Record<ArchVisualCpp, PaquetVisualCpp> = {
  x64: {
    arch: "x64",
    version: "14.51.36247.0",
    adresse: "https://download.visualstudio.microsoft.com/download/pr/ebdab8e5-1d7b-4d9f-a11b-cbb1720c3b12/843068991DAAA1F73AD9F6239BCE4D0F6A07A51F18C37EA2A867E9BECA71295C/VC_redist.x64.exe",
    octets: 18_731_856,
    sha256: "843068991daaa1f73ad9f6239bce4d0f6a07a51f18c37ea2a867e9beca71295c",
  },
  arm64: {
    arch: "arm64",
    version: "14.51.36247.0",
    adresse: "https://download.visualstudio.microsoft.com/download/pr/ece44298-3977-4f73-ab91-c13fe79cfea8/B70EF586669A620A0A30A1156969C05C6A3831DC8F8BC992DA75779D2A92F944/VC_redist.arm64.exe",
    octets: 11_870_816,
    sha256: "b70ef586669a620a0a30a1156969c05c6a3831dc8f8bc992da75779d2a92f944",
  },
};

/** Les DLL du Visual C++ que les modules d'OpenClaw importent (relevé du 29/09/2026), dans `System32`. */
export const DLL_VISUAL_CPP = ["VCRUNTIME140.dll"] as const;

/**
 * Version minimale de la bibliothèque en place, par processeur. Microsoft
 * (page du paquet, lue le 29/09/2026) : « la version du paquet installé doit
 * être égale ou supérieure à celle des outils MSVC qui ont construit
 * l'application ». Éditeur de liens relevé dans l'en-tête PE des modules qui
 * importent `VCRUNTIME140.dll` : `fs-safe` x64 14.51, `ubjs` x64 et arm64
 * 14.44. En dessous, la version épinglée (14.51.36247) est installée
 * par-dessus : le paquet remplace une 14.x plus ancienne. Monter OpenClaw,
 * c'est relever ces deux nombres (`modules-dll.txt` de l'essai de GitHub).
 */
export const VERSION_MINIMALE_VISUAL_CPP: Record<ArchVisualCpp, string> = { x64: "14.51", arm64: "14.44" };

/** Le sujet du certificat qui signe les paquets de Microsoft. */
export const SIGNATAIRE_MICROSOFT = "CN=Microsoft Corporation, O=Microsoft Corporation, L=Redmond, S=Washington, C=US";

/**
 * Racine de Microsoft à laquelle la chaîne du signataire doit remonter, par
 * empreinte SHA-1 (celle que Windows affiche) : « Microsoft Root Certificate
 * Authority 2011 », relevée sur les deux paquets épinglés le 29/09/2026
 * (statut `Valid`, « Signature verified. »). Une signature valide pour
 * Windows, mais qui remonte à une autre racine (une racine ajoutée au
 * magasin de la machine par un tiers, par exemple), est refusée. Un nouveau
 * paquet signé sous une autre racine de Microsoft demandera de l'ajouter ici,
 * après l'avoir relevée.
 */
export const RACINES_MICROSOFT = ["8F43288AD272F3103B6FB1428485EA3014C0BCFE"] as const;

/** Le paquet pour ce processeur, ou null (Windows 32 bits : OxoAI n'y pose pas de Node). */
export function paquetVisualCpp(arch: string): PaquetVisualCpp | null {
  return arch === "x64" || arch === "arm64" ? PAQUETS_VISUAL_CPP[arch] : null;
}

/* ---- Versions ------------------------------------------------------------ */

const nombres = (v: string) => v.split(".").map((x) => Number.parseInt(x, 10) || 0);

/** `a` est-elle au moins `b` ? Nombre par nombre (« 14.44.35211 » ≥ « 14.44 »). */
export function versionAuMoins(a: string, b: string): boolean {
  const [x, y] = [nombres(a.replace(/^v/i, "")), nombres(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
  }
  return true;
}

/* ---- Détection ----------------------------------------------------------- */

/** Ce que PowerShell a relevé sur la machine (voir `SCRIPT_RELEVE`). */
export interface ReleveVisualCpp {
  /** Clé `HKLM\SOFTWARE\[WOW6432Node\]Microsoft\VisualStudio\14.0\VC\Runtimes\<arch>`, vue 64 et 32 bits. */
  registre: { installe?: number | null; version?: string | null }[];
  /** Chaque DLL cherchée dans `System32` : présente, et sa version de fichier. */
  dll: { nom: string; present: boolean; version?: string | null }[];
}

export type VerdictVisualCpp =
  | { etat: "present"; version: string }
  | { etat: "absent"; manque: string[] }
  | { etat: "ancien"; version: string };

/**
 * Présentes ou non : toutes les DLL nécessaires dans `System32`, et une
 * version au moins égale à la minimale de ce processeur. La version est celle
 * du fichier, c'est lui que Windows charge (une DLL posée par un autre
 * programme, sans le paquet, compte aussi) ; celle du registre ne sert que si
 * le fichier ne dit pas la sienne. Une DLL absente l'emporte sur le registre.
 * Les machines de GitHub ont la DLL (14.51.36247) sans la clé du registre
 * (relevé du 29/09/2026) : le registre seul aurait dit « absentes ».
 */
export function verdictVisualCpp(r: ReleveVisualCpp, arch: ArchVisualCpp): VerdictVisualCpp {
  const manque = DLL_VISUAL_CPP.filter((nom) => !r.dll.some((d) => d.nom.toLowerCase() === nom.toLowerCase() && d.present));
  if (manque.length) return { etat: "absent", manque };
  const valable = (v: string) => /^v?\d+\.\d+/.test(v) && !/^v?0\./.test(v);
  const duFichier = r.dll.map((d) => String(d.version ?? "")).filter(valable);
  const versions = (duFichier.length ? duFichier : r.registre.filter((k) => k.installe === 1 && k.version).map((k) => String(k.version))).filter(valable);
  const meilleure = versions.sort((a, b) => (versionAuMoins(a, b) ? -1 : 1))[0];
  if (!meilleure) return { etat: "ancien", version: "?" };
  const propre = meilleure.replace(/^v/i, "");
  return versionAuMoins(propre, VERSION_MINIMALE_VISUAL_CPP[arch]) ? { etat: "present", version: propre } : { etat: "ancien", version: propre };
}

/** Lit la sortie JSON de `SCRIPT_RELEVE` ; null si elle est illisible. */
export function lireReleve(sortie: string): ReleveVisualCpp | null {
  try {
    const brut = JSON.parse(sortie.trim()) as { registre?: unknown; dll?: unknown };
    const liste = (x: unknown) => (Array.isArray(x) ? x : x && typeof x === "object" ? [x] : []);
    return {
      registre: liste(brut.registre).map((k) => ({ installe: Number((k as { installe?: unknown }).installe ?? 0), version: String((k as { version?: unknown }).version ?? "") || null })),
      dll: liste(brut.dll).map((d) => ({ nom: String((d as { nom?: unknown }).nom ?? ""), present: (d as { present?: unknown }).present === true, version: String((d as { version?: unknown }).version ?? "") || null })),
    };
  } catch {
    return null;
  }
}

/*
 * Les trois scripts PowerShell sont des constantes : aucun ne porte de
 * donnée. Le processeur, le fichier à vérifier ou à lancer et son journal
 * passent par des variables d'environnement (`OXOAI_VC_*`), lues par
 * PowerShell comme des chaînes, jamais interprétées comme du code.
 */

/** Relève la clé du registre (vues 64 et 32 bits) et les DLL de `System32`, en JSON. */
export const SCRIPT_RELEVE = [
  "$ErrorActionPreference = 'SilentlyContinue'",
  "$a = $env:OXOAI_VC_ARCH",
  "$reg = foreach ($c in @('HKLM:\\SOFTWARE\\Microsoft\\VisualStudio\\14.0\\VC\\Runtimes\\' + $a, 'HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\VisualStudio\\14.0\\VC\\Runtimes\\' + $a)) { $k = Get-ItemProperty -LiteralPath $c; if ($k) { @{ installe = [int]$k.Installed; version = [string]$k.Version } } }",
  "$dll = foreach ($n in ($env:OXOAI_VC_DLL -split ';')) { $f = Join-Path (Join-Path $env:SystemRoot 'System32') $n; $i = Get-Item -LiteralPath $f; if ($i) { $v = $i.VersionInfo; @{ nom = $n; present = $true; version = ('{0}.{1}.{2}.{3}' -f $v.FileMajorPart, $v.FileMinorPart, $v.FileBuildPart, $v.FilePrivatePart) } } else { @{ nom = $n; present = $false } } }",
  "[Console]::Out.Write((@{ registre = @($reg); dll = @($dll) } | ConvertTo-Json -Compress -Depth 4))",
].join("\n");

/** Signature Authenticode du fichier `OXOAI_VC_FICHIER` : statut, signataire, racine de la chaîne. */
export const SCRIPT_SIGNATURE = [
  "$ErrorActionPreference = 'Stop'",
  "$s = Get-AuthenticodeSignature -LiteralPath $env:OXOAI_VC_FICHIER",
  "$r = @{ statut = [string]$s.Status; message = [string]$s.StatusMessage; signataire = ''; racine = ''; empreinteRacine = ''; version = [string](Get-Item -LiteralPath $env:OXOAI_VC_FICHIER).VersionInfo.ProductVersion }",
  "if ($s.SignerCertificate) {",
  "  $r.signataire = $s.SignerCertificate.Subject",
  "  $c = New-Object System.Security.Cryptography.X509Certificates.X509Chain",
  "  $c.ChainPolicy.RevocationMode = [System.Security.Cryptography.X509Certificates.X509RevocationMode]::NoCheck",
  "  $c.ChainPolicy.VerificationFlags = [System.Security.Cryptography.X509Certificates.X509VerificationFlags]::IgnoreNotTimeValid",
  "  [void]$c.Build($s.SignerCertificate)",
  "  $x = $c.ChainElements[$c.ChainElements.Count - 1].Certificate",
  "  $r.racine = $x.Subject; $r.empreinteRacine = $x.Thumbprint",
  "}",
  "[Console]::Out.Write(($r | ConvertTo-Json -Compress))",
].join("\n");

/**
 * Lance l'installeur `OXOAI_VC_FICHIER` avec l'élévation que Windows demande
 * (UAC), sans fenêtre (`/quiet`), sans redémarrer (`/norestart`), journal dans
 * `OXOAI_VC_JOURNAL` ; rend son code de sortie, ou le code natif de l'erreur
 * de lancement (1223 : la personne, ou Windows, a refusé l'autorisation).
 * `Start-Process` passe par ShellExecute, pas par `cmd.exe`.
 */
export const SCRIPT_INSTALLATION = [
  "$ErrorActionPreference = 'Stop'",
  "try {",
  "  $p = Start-Process -FilePath $env:OXOAI_VC_FICHIER -ArgumentList @('/install', '/quiet', '/norestart', '/log', ('\"' + $env:OXOAI_VC_JOURNAL + '\"')) -Verb RunAs -PassThru",
  // Le handle lu tout de suite : sans lui, `ExitCode` d'un processus élevé revient vide.
  "  $h = $p.Handle",
  "  $p.WaitForExit()",
  "  [Console]::Out.Write((@{ code = $p.ExitCode } | ConvertTo-Json -Compress))",
  "} catch {",
  "  $e = $_.Exception; $n = 0",
  "  while ($e) { if ($e -is [System.ComponentModel.Win32Exception]) { $n = $e.NativeErrorCode; break }; $e = $e.InnerException }",
  "  [Console]::Out.Write((@{ code = $null; natif = $n; erreur = [string]$_.Exception.Message } | ConvertTo-Json -Compress))",
  "}",
].join("\n");

/**
 * Windows PowerShell de System32 (lu dans `SystemRoot`, pas par le PATH),
 * script encodé (`-EncodedCommand`, UTF-16LE en base64) : aucun guillemet à
 * échapper. Même forme que `commandeLigneDeProcessus` (plateformeOpenClaw.ts).
 */
export function commandePowerShell(script: string, env: Record<string, string | undefined>): { fichier: string; args: string[] } {
  const racine = Object.entries(env).find(([k]) => /^systemroot$/i.test(k))?.[1] ?? "C:\\Windows";
  return {
    fichier: win32.join(racine, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
  };
}

/**
 * L'environnement de ce Windows PowerShell : celui de la passerelle, plus les
 * variables `OXOAI_VC_*`, **sans `PSModulePath`**. Vu sur le Windows de GitHub
 * le 29/09/2026 : lancé depuis PowerShell 7, Windows PowerShell 5.1 hérite de
 * ses dossiers de modules, et `Get-AuthenticodeSignature` ne se charge plus
 * (le module de PowerShell 7 du même nom est pris à la place). Sans la
 * variable, il reprend ses dossiers d'office. Même cas chez une personne qui
 * lancerait OxoAI depuis PowerShell 7.
 */
export function envPowerShell(source: Record<string, string | undefined>, variables: Record<string, string>): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(source)) if (!/^psmodulepath$/i.test(k)) env[k] = v;
  return { ...env, ...variables };
}

/* ---- Signature ----------------------------------------------------------- */

export interface Signature {
  statut: string;
  message?: string;
  signataire: string;
  racine?: string;
  empreinteRacine: string;
  version?: string;
}

/**
 * La signature est-elle celle de Microsoft ? `Valid` pour Windows (chaîne de
 * confiance, fichier intact depuis sa signature), signataire exactement
 * « Microsoft Corporation » (organisation et nom commun), racine de la chaîne
 * parmi celles de Microsoft. Null si tout va, la raison sinon.
 */
export function refusSignature(s: Signature | null): string | null {
  if (!s) return t("la signature n'a pas pu être lue");
  if (s.statut !== "Valid") return tf("Windows ne reconnaît pas sa signature ({0})", s.statut || "?");
  const champs = new Map(
    s.signataire
      .split(/,\s*/)
      .map((c) => c.split("="))
      .map(([k, ...v]) => [String(k).trim().toUpperCase(), v.join("=").trim()]),
  );
  if (champs.get("CN") !== "Microsoft Corporation" || champs.get("O") !== "Microsoft Corporation") return tf("il n'est pas signé par Microsoft ({0})", s.signataire.slice(0, 120));
  if (!(RACINES_MICROSOFT as readonly string[]).includes(s.empreinteRacine.toUpperCase())) return tf("sa signature ne remonte pas à une racine de Microsoft ({0})", (s.racine ?? s.empreinteRacine).slice(0, 120));
  return null;
}

/* ---- Issue de l'installeur ----------------------------------------------- */

export interface IssueInstalleur {
  ok: boolean;
  /** Windows demande un redémarrage pour finir (3010). */
  redemarrage?: boolean;
  /** Pour l'écran, quand ce n'est pas bon. */
  message?: string;
}

/** Lit la sortie de `SCRIPT_INSTALLATION` : le code de l'installeur, ou le code natif d'un lancement refusé. */
export function lireCodeInstalleur(sortie: string): { code: number | null; natif?: number; erreur?: string } {
  try {
    const r = JSON.parse(sortie.trim()) as { code?: unknown; natif?: unknown; erreur?: unknown };
    return {
      code: typeof r.code === "number" ? r.code : null,
      ...(typeof r.natif === "number" && r.natif ? { natif: r.natif } : {}),
      ...(typeof r.erreur === "string" && r.erreur ? { erreur: r.erreur } : {}),
    };
  } catch {
    return { code: null };
  }
}

/**
 * Ce que dit le code de sortie de l'installeur (codes de Windows Installer,
 * que le paquet de Microsoft reprend) : 0 installé ; 1638 une version égale
 * ou plus récente est déjà là ; 3010 (ou 1641) installé, redémarrage
 * conseillé ; 1223 (ou 1602, 740, 5) l'autorisation d'administrateur refusée
 * ou impossible ; 1618 une autre installation en cours ; le reste, une panne.
 */
export function issueInstalleur(code: number | null, natif?: number): IssueInstalleur {
  const refuse = t("Windows a refusé l'autorisation d'administrateur. Relancez et acceptez la demande de Windows (si elle n'apparaît pas, regardez la barre des tâches). Si ce compte n'a pas le mot de passe d'un administrateur, demandez à la personne qui gère ce PC d'installer le « Microsoft Visual C++ Redistributable » depuis") + ` ${PAGE_VISUAL_CPP}`;
  if (code === 0 || code === 1638) return { ok: true };
  if (code === 3010 || code === 1641) return { ok: true, redemarrage: true };
  if (code === 1223 || code === 1602 || natif === 1223 || natif === 740 || natif === 5) return { ok: false, message: refuse };
  if (code === 1618) return { ok: false, message: t("Une autre installation est en cours sur ce PC (souvent Windows Update) : réessayez dans quelques minutes.") };
  if (code === null) return { ok: false, message: tf("L'installeur de Microsoft n'a pas pu être lancé ({0}).", natif ? tf("erreur {0} de Windows", natif) : t("sans code")) };
  return { ok: false, message: tf("L'installeur de Microsoft s'est arrêté avec le code {0}. Vous pouvez installer le « Microsoft Visual C++ Redistributable » vous-même depuis {1}", code, PAGE_VISUAL_CPP) };
}

/* ---- Ce qui ne tourne que sous Windows ------------------------------------ */

const racine = () => join(process.env.OXOAI_DATA_DIR ?? join(homedir(), ".oxoai", "data"), "visual-cpp");

function powershell(script: string, variables: Record<string, string>, delaiMs: number): Promise<{ ok: boolean; sortie: string; erreur: string }> {
  const env = envPowerShell(process.env, variables);
  const c = commandePowerShell(script, env);
  return new Promise((resolve) =>
    execFile(c.fichier, c.args, { env, timeout: delaiMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, sortie, erreur) =>
      resolve({ ok: !err, sortie: String(sortie), erreur: String(erreur) || (err ? err.message : "") }),
    ),
  );
}

/**
 * Variable réservée aux essais (SECURITE.md § 64) : `OXOAI_ESSAI_VISUAL_CPP=absent`
 * fait dire « absentes » à la détection, jusqu'à ce qu'une installation ait
 * tourné dans ce processus, pour faire passer tout le chemin (téléchargement,
 * vérifications, installeur réel) sur une machine qui les a déjà. Elle ne
 * donne rien de plus que ce que le chemin normal fait : le même paquet épinglé,
 * sous la même autorisation de Windows. Posée par qui lance la passerelle,
 * jamais par une requête.
 */
let installeeIci = false;
const forceeAbsente = () => process.env.OXOAI_ESSAI_VISUAL_CPP === "absent" && !installeeIci;

let cache: { verdict: VerdictVisualCpp | null; at: number } | null = null;

/**
 * Les bibliothèques sont-elles là ? `null` hors de Windows (rien à faire), ou
 * quand le relevé est illisible (on ne bloque pas une installation sur un
 * doute : OpenClaw dira lui-même s'il ne démarre pas). Gardé dix minutes.
 */
export async function detecterVisualCpp(forcer = false): Promise<VerdictVisualCpp | null> {
  if (process.platform !== "win32") return null;
  if (forceeAbsente()) return { etat: "absent", manque: [...DLL_VISUAL_CPP] };
  if (!forcer && cache && Date.now() - cache.at < 10 * 60_000) return cache.verdict;
  const paquet = paquetVisualCpp(process.arch);
  if (!paquet) return null;
  const r = await powershell(SCRIPT_RELEVE, { OXOAI_VC_ARCH: paquet.arch, OXOAI_VC_DLL: DLL_VISUAL_CPP.join(";") }, 30_000);
  const releve = r.ok ? lireReleve(r.sortie) : null;
  if (!releve) console.warn(`[visual-cpp] relevé illisible : ${(r.erreur || r.sortie).slice(0, 300)}`);
  const verdict = releve ? verdictVisualCpp(releve, paquet.arch) : null;
  cache = { verdict, at: Date.now() };
  return verdict;
}

/** Dernier relevé connu, sans en lancer un (pour l'écran). */
export const visualCppConnu = (): VerdictVisualCpp | null => (process.platform === "win32" ? (forceeAbsente() ? { etat: "absent", manque: [...DLL_VISUAL_CPP] } : (cache?.verdict ?? null)) : null);

async function empreinteFichier(fichier: string): Promise<string> {
  const h = createHash("sha256");
  await pipeline(createReadStream(fichier), h);
  return h.digest("hex");
}

/**
 * Télécharge, vérifie et lance le paquet de Microsoft pour ce processeur. Rend
 * `{ redemarrage }` quand Windows conseille de redémarrer ; lève une erreur
 * dans la langue de l'écran sinon. Journal de la passerelle : ce qui a été fait, la sortie
 * de l'installeur quand il échoue.
 */
export async function installerVisualCpp(avancer?: (pourcent: number) => void): Promise<{ redemarrage: boolean; version: string }> {
  if (process.platform !== "win32") throw new Error(t("Les bibliothèques Visual C++ ne s'installent que sous Windows."));
  const paquet = paquetVisualCpp(process.arch);
  if (!paquet) throw new Error(tf("Pas de paquet Visual C++ pour ce processeur ({0}).", process.arch));

  let reponse: Response;
  try {
    // Aucune redirection suivie : l'adresse épinglée sert le fichier elle-même.
    reponse = await fetch(paquet.adresse, { redirect: "error", signal: AbortSignal.timeout(15 * 60_000) });
  } catch {
    throw new Error(t("download.visualstudio.microsoft.com est injoignable : vérifiez l'accès à internet de cette machine, puis réessayez."));
  }
  if (!reponse.ok || !reponse.body) throw new Error(tf("Téléchargement des bibliothèques de Microsoft impossible (HTTP {0}).", reponse.status));

  /*
   * Dans un dossier à soi, sous les données de OxoAI (dossier personnel du
   * compte : les autres comptes n'y écrivent pas), jamais dans le dossier
   * temporaire commun ; nom unique, fichier créé par nous seuls (`wx`).
   */
  mkdirSync(racine(), { recursive: true, mode: 0o700 });
  const travail = mkdtempSync(join(racine(), ".telechargement-"));
  const fichier = join(travail, `VC_redist.${paquet.arch}.exe`);
  const journal = join(travail, "vc_redist.log");
  try {
    const empreinte = createHash("sha256");
    let recu = 0;
    const flux = Readable.fromWeb(reponse.body as import("node:stream/web").ReadableStream<Uint8Array>);
    flux.on("data", (morceau: Buffer) => {
      empreinte.update(morceau);
      recu += morceau.length;
      // Plus gros qu'annoncé : ce n'est pas le bon fichier, inutile d'aller au bout.
      if (recu > paquet.octets) flux.destroy(new Error("trop gros"));
      avancer?.(Math.min(99, Math.round((recu / paquet.octets) * 100)));
    });
    try {
      await pipeline(flux, createWriteStream(fichier, { mode: 0o600, flags: "wx" }));
    } catch {
      throw new Error(t("Le téléchargement des bibliothèques de Microsoft s'est interrompu : vérifiez la connexion, puis réessayez."));
    }
    if (recu !== paquet.octets || empreinte.digest("hex") !== paquet.sha256) {
      throw new Error(t("Le paquet de Microsoft téléchargé ne correspond pas à son empreinte : il a été effacé sans être lancé."));
    }

    const lue = await powershell(SCRIPT_SIGNATURE, { OXOAI_VC_FICHIER: fichier }, 60_000);
    let signature: Signature | null = null;
    try {
      signature = JSON.parse(lue.sortie.trim()) as Signature;
    } catch {
      console.warn(`[visual-cpp] signature illisible : ${(lue.erreur || lue.sortie).slice(0, 4000)}`);
    }
    const refus = refusSignature(signature);
    if (refus) throw new Error(tf("Le paquet de Microsoft a été refusé : {0}. Il a été effacé sans être lancé.", refus));

    // Relu juste avant d'être lancé, au même endroit : le fichier lancé est celui qui a été vérifié.
    if ((await empreinteFichier(fichier)) !== paquet.sha256) throw new Error(t("Le paquet de Microsoft a changé après sa vérification : il a été effacé sans être lancé."));

    console.log(`[visual-cpp] lancement de VC_redist.${paquet.arch}.exe ${paquet.version} (empreinte et signature de Microsoft vérifiées), autorisation d'administrateur demandée à Windows`);
    // Jusqu'à quinze minutes : la demande de Windows attend la personne.
    const r = await powershell(SCRIPT_INSTALLATION, { OXOAI_VC_FICHIER: fichier, OXOAI_VC_JOURNAL: journal }, 15 * 60_000);
    installeeIci = true;
    const { code, natif, erreur } = lireCodeInstalleur(r.sortie);
    const issue = issueInstalleur(code, natif);
    console.log(`[visual-cpp] installeur terminé : code ${code ?? "aucun"}${natif ? `, erreur ${natif} de Windows` : ""}${erreur ? ` (${erreur})` : ""}`);
    if (!issue.ok) {
      let fin = "";
      try {
        fin = readFileSync(journal, "utf16le").slice(-8000);
        if (!/\w{4}/.test(fin)) fin = readFileSync(journal, "utf8").slice(-8000);
      } catch {
        /* pas de journal : l'installeur n'a pas démarré */
      }
      console.error(`[visual-cpp] échec de l'installeur (code ${code ?? "aucun"}) :\n${r.erreur}\n${fin}`);
      throw new Error(issue.message);
    }
    const apres = await detecterVisualCpp(true);
    if (apres && apres.etat !== "present") {
      console.error(`[visual-cpp] installeur terminé (code ${code}), mais la détection dit encore ${JSON.stringify(apres)}`);
      throw new Error(tf("L'installeur de Microsoft a fini, mais les bibliothèques Visual C++ restent introuvables. Réparez-les dans Paramètres > Applications (« Microsoft Visual C++ Redistributable », Modifier, Réparer), ou installez-les depuis {0}", PAGE_VISUAL_CPP));
    }
    return { redemarrage: Boolean(issue.redemarrage), version: apres?.etat === "present" ? apres.version : paquet.version };
  } finally {
    rmSync(travail, { recursive: true, force: true, maxRetries: 5 });
    if (!existsSync(travail)) avancer?.(100);
  }
}
