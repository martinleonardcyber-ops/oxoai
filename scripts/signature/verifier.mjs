/**
 * Vérifie qu'un paquet macOS est réellement signé, durci, notarié et agrafé.
 *
 *   npm run verifier:signature                       (dernier paquet construit)
 *   npm run verifier:signature -- chemin/vers/OxoAI.app
 *
 * Tant que les quatre points ne sont pas verts, la signature n'est pas faite,
 * quoi qu'en dise la sortie de construction.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// fileURLToPath et non `.pathname` : le chemin du projet contient des espaces.
const racine = fileURLToPath(new URL("../../", import.meta.url));
const pkg = JSON.parse(readFileSync(join(racine, "package.json"), "utf8"));
const nom = pkg.build?.productName ?? "OxoAI";

/** Code de retour et sortie complète : `codesign -d` et `spctl` écrivent sur la sortie d'erreur. */
function sortie(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: "utf8" });
  return { ok: r.status === 0, texte: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

const appli = process.argv[2] ?? join(racine, "release", "mac-arm64", `${nom}.app`);
if (!existsSync(appli)) {
  console.error(`Paquet introuvable : ${appli}\nConstruisez-le d'abord (npm run package:signe).`);
  process.exit(1);
}
const dmg = readdirSync(join(racine, "release"))
  .filter((f) => f.endsWith(".dmg") && f.includes(pkg.version))
  .map((f) => join(racine, "release", f))[0];

const details = sortie("/usr/bin/codesign", ["-dvvv", appli]).texte;
const equipe = /TeamIdentifier=(\S.*)/.exec(details)?.[1]?.trim();
const autorite = /Authority=(Developer ID Application:[^\n]+)/.exec(details)?.[1];
const drapeaux = /flags=0x[0-9a-f]+\(([^)]*)\)/.exec(details)?.[1] ?? "";

const points = [
  {
    nom: "Signature d'éditeur (Developer ID)",
    ok: Boolean(autorite) && Boolean(equipe) && equipe !== "not set",
    detail: autorite ? `${autorite}, équipe ${equipe}` : `aucune (TeamIdentifier=${equipe ?? "?"})`,
  },
  {
    nom: "Durcissement (hardened runtime)",
    ok: drapeaux.split(",").includes("runtime"),
    detail: `drapeaux : ${drapeaux || "aucun"}`,
  },
  {
    nom: "Intégrité de toute l'application",
    ok: sortie("/usr/bin/codesign", ["--verify", "--deep", "--strict", appli]).ok,
    detail: "codesign --verify --deep --strict",
  },
  {
    nom: "Gatekeeper accepte l'application",
    ok: /accepted/.test(sortie("/usr/sbin/spctl", ["--assess", "--type", "execute", "--verbose", appli]).texte),
    detail: sortie("/usr/sbin/spctl", ["--assess", "--type", "execute", "--verbose", appli]).texte.trim().split("\n").pop(),
  },
  {
    nom: "Ticket de notarisation agrafé (application)",
    ok: sortie("/usr/bin/xcrun", ["stapler", "validate", appli]).ok,
    detail: "xcrun stapler validate",
  },
];
if (dmg) {
  points.push({
    nom: "Ticket de notarisation agrafé (image disque)",
    ok: sortie("/usr/bin/xcrun", ["stapler", "validate", dmg]).ok,
    detail: dmg.split("/").pop(),
  });
}

console.log(`\nVérification de ${appli}\n`);
for (const p of points) console.log(`  ${p.ok ? "✓" : "✗"} ${p.nom}\n      ${p.detail}`);

const droits = sortie("/usr/bin/codesign", ["-d", "--entitlements", "-", "--xml", appli]).texte;
const liste = [...droits.matchAll(/<key>([^<]+)<\/key>/g)].map((m) => m[1]);
console.log(`\n  Droits déclarés (${liste.length}) :`);
for (const d of liste) console.log(`      ${d}`);

const echecs = points.filter((p) => !p.ok).length;
console.log(echecs === 0 ? "\nTout est en ordre : le paquet peut être diffusé.\n" : `\n${echecs} point(s) en échec : ne pas diffuser ce paquet.\n`);
process.exit(echecs === 0 ? 0 : 1);
