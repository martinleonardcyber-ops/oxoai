import { execFile } from "node:child_process";
import { readdirSync, readFileSync, readlinkSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

/**
 * Qui écoute sur un port de la boucle locale ? Lu au système, jamais demandé
 * au programme lui-même.
 *
 * Sorti de blender.ts le 16/10/2026, quand Unreal Editor (unreal.ts) en a eu
 * besoin à son tour : même question, mêmes lectures. Ce module ne décide de
 * rien ; chaque application dit, de son côté, ce qu'elle accepte (signature,
 * nom de l'exécutable).
 *  - macOS : `lsof` (les numéros des processus à l'écoute) ;
 *  - Linux : `/proc/net/tcp` puis `/proc/<pid>/fd`, sans `lsof` (absent des
 *    installations minimales) ; une socket dont on ne trouve pas le processus
 *    (un autre compte) rend la réponse illisible ;
 *  - Windows : PowerShell, le processus à l'écoute, son chemin, sa signature
 *    Authenticode et son heure de départ.
 */

const executer = promisify(execFile);

export interface Ecouteur {
  pid: number;
  /** Chemin de l'exécutable, quand le système le donne. */
  exe: string | null;
  /** Windows : la signature Authenticode, lue par PowerShell (`Valid`, `NotSigned`…). */
  signature?: { statut: string; sujet: string };
  /** Windows : l'heure de départ du processus, lue par PowerShell. */
  debut?: string;
}

/** Numéro, exécutable et heure de départ du processus ; `null` si le système ne les donne pas. */
export async function identite(e: Ecouteur): Promise<string | null> {
  try {
    if (process.platform === "win32") return e.exe && e.debut ? `${e.pid}|${e.exe}|${e.debut}` : null;
    if (process.platform === "linux") {
      const stat = readFileSync(`/proc/${e.pid}/stat`, "utf8");
      const champs = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      const exe = e.exe ?? readlinkSync(`/proc/${e.pid}/exe`);
      return champs[19] ? `${e.pid}|${exe}|${champs[19]}` : null;
    }
    const { stdout } = await executer("/bin/ps", ["-o", "lstart=", "-o", "comm=", "-p", String(e.pid)], { timeout: 15_000 });
    const ligne = stdout.trim();
    return ligne ? `${e.pid}|${ligne}` : null;
  } catch {
    return null;
  }
}

/** macOS : `lsof`, comme palmier.ts. */
async function ecouteursMac(port: number): Promise<Ecouteur[]> {
  let stdout = "";
  try {
    ({ stdout } = await executer("/usr/sbin/lsof", ["-nP", "-a", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], { timeout: 15_000 }));
  } catch (err) {
    const e = err as { code?: unknown; stdout?: string };
    if (e.code === 1 && !String(e.stdout ?? "").trim()) return [];
    throw err;
  }
  return stdout.split("\n").map(Number).filter((n) => Number.isInteger(n) && n > 0).map((pid) => ({ pid, exe: null }));
}

/** Linux : les sockets à l'écoute sur le port (`/proc/net/tcp`, état 0A), puis le processus qui tient chacune. */
async function ecouteursLinux(port: number): Promise<Ecouteur[]> {
  const inodes = new Set<string>();
  const portHex = port.toString(16).toUpperCase().padStart(4, "0");
  for (const f of ["/proc/net/tcp", "/proc/net/tcp6"]) {
    let texte = "";
    try {
      texte = readFileSync(f, "utf8");
    } catch {
      continue;
    }
    for (const ligne of texte.split("\n").slice(1)) {
      const champs = ligne.trim().split(/\s+/);
      if (champs.length < 10) continue;
      if (champs[1]!.split(":")[1] === portHex && champs[3] === "0A") inodes.add(champs[9]!);
    }
  }
  if (inodes.size === 0) return [];
  const trouves: Ecouteur[] = [];
  const restants = new Set(inodes);
  for (const d of readdirSync("/proc")) {
    if (!/^\d+$/.test(d)) continue;
    let fds: string[] = [];
    try {
      fds = readdirSync(`/proc/${d}/fd`);
    } catch {
      continue;
    }
    for (const fd of fds) {
      let lien = "";
      try {
        lien = readlinkSync(`/proc/${d}/fd/${fd}`);
      } catch {
        continue;
      }
      const m = /^socket:\[(\d+)\]$/.exec(lien);
      if (m && restants.has(m[1]!)) {
        restants.delete(m[1]!);
        let exe: string | null = null;
        try {
          exe = readlinkSync(`/proc/${d}/exe`);
        } catch {
          exe = null;
        }
        if (!trouves.some((e) => e.pid === Number(d))) trouves.push({ pid: Number(d), exe });
      }
    }
  }
  if (restants.size > 0) throw new Error("socket sans processus lisible");
  return trouves;
}

/** Windows : PowerShell, le processus à l'écoute, son chemin et sa signature Authenticode. */
async function ecouteursWindows(port: number): Promise<Ecouteur[]> {
  const script =
    `$r = @(Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | ForEach-Object { ` +
    `$p = Get-Process -Id $_.OwningProcess -ErrorAction SilentlyContinue; $s = $null; ` +
    `if ($p -and $p.Path) { $s = Get-AuthenticodeSignature -LiteralPath $p.Path }; ` +
    `$d = $null; if ($p) { try { $d = [string]$p.StartTime.ToFileTimeUtc() } catch { } }; ` +
    `[pscustomobject]@{ pid = [int]$_.OwningProcess; exe = [string]$p.Path; statut = [string]$s.Status; sujet = [string]$s.SignerCertificate.Subject; debut = [string]$d } }); ` +
    `ConvertTo-Json -InputObject $r -Compress`;
  const powershell = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const { stdout } = await executer(powershell, ["-NoProfile", "-NonInteractive", "-Command", script], { timeout: 30_000, windowsHide: true });
  type Brut = { pid: number; exe: string; statut: string; sujet: string; debut?: string };
  const brut = JSON.parse(stdout.trim() || "[]") as Brut[] | Brut;
  return (Array.isArray(brut) ? brut : [brut]).map((e) => ({ pid: e.pid, exe: e.exe || null, signature: { statut: e.statut, sujet: e.sujet }, ...(e.debut ? { debut: e.debut } : {}) }));
}

/** Les processus à l'écoute sur ce port de la machine. Lève une erreur si le système ne sait pas le dire. */
export async function ecouteurs(port: number): Promise<Ecouteur[]> {
  if (process.platform === "darwin") return ecouteursMac(port);
  if (process.platform === "win32") return ecouteursWindows(port);
  return ecouteursLinux(port);
}

export const reel = (chemin: string): string => {
  try {
    return realpathSync(chemin);
  } catch {
    return chemin;
  }
};

/** L'exécutable d'un processus, lu par `lsof` (macOS). */
export async function executableParLsof(pid: number): Promise<string | null> {
  const { stdout } = await executer("/usr/sbin/lsof", ["-nP", "-a", "-p", String(pid), "-d", "txt", "-Fn"], { timeout: 15_000 });
  const ligne = stdout.split("\n").find((l) => l.startsWith("n"));
  return ligne ? ligne.slice(1) : null;
}

/**
 * Un programme de ce nom tourne-t-il sur la machine (sans regarder ses ports) ?
 * Pour le message seulement (« l'éditeur n'est pas ouvert » ou « son serveur
 * n'est pas démarré ») : rien n'est décidé là-dessus. `null` si on ne sait pas.
 */
export async function processusOuvert(noms: { mac: string; windows: string; linux: RegExp }): Promise<boolean | null> {
  try {
    if (process.platform === "win32") {
      const { stdout } = await executer("tasklist.exe", ["/FI", `IMAGENAME eq ${noms.windows}`, "/FO", "CSV", "/NH"], { timeout: 15_000, windowsHide: true });
      return stdout.toLowerCase().includes(`"${noms.windows.toLowerCase()}"`);
    }
    if (process.platform === "linux") {
      for (const d of readdirSync("/proc")) {
        if (!/^\d+$/.test(d)) continue;
        try {
          if (noms.linux.test(readFileSync(`/proc/${d}/comm`, "utf8").trim())) return true;
        } catch {
          /* processus parti */
        }
      }
      return false;
    }
    try {
      await executer("/usr/bin/pgrep", ["-x", noms.mac], { timeout: 15_000 });
      return true;
    } catch (err) {
      return (err as { code?: unknown }).code === 1 ? false : null;
    }
  } catch {
    return null;
  }
}
