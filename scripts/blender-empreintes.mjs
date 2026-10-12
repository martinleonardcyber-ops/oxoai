/*
 * Serveur MCP de Blender (gateway/src/blender.ts, 12/10/2026) : paquets Python
 * figés avec leurs empreintes.
 *
 *   node scripts/blender-empreintes.mjs
 *
 * Même méthode que scripts/atelier-empreintes.mjs : `uv` résout, pour tous les
 * systèmes et pour Python 3.10 à 3.14 d'un coup (`--universal`), la liste
 * complète des paquets de `mcp-for-blender` à sa version épinglée,
 * dépendances comprises, et relève sur PyPI l'empreinte SHA-256 de chacune de
 * leurs roues. Le résultat va dans `gateway/src/blender-paquets.json` ; la
 * passerelle installe ensuite avec `pip --require-hashes --no-deps
 * --only-binary=:all:` : un paquet absent de la liste, ou dont le fichier n'a
 * pas l'une des empreintes relevées, est refusé.
 *
 * Le script relève aussi la licence de chaque paquet sur PyPI (écrite dans le
 * fichier, pour la relecture : PROJET.md § 3.5 en tient le compte), et
 * l'empreinte du module complémentaire livré dans la roue
 * (`blender_mcp/bundled/addon.py`), que blender.ts vérifie avant de le
 * proposer à Blender.
 *
 * Pour changer de version : modifier VERSION, relancer, relire le différentiel
 * (surtout les licences et le module complémentaire : outils nouveaux, appels
 * sortants), reporter l'empreinte du module dans blender.ts, et réessayer avec
 * un vrai Blender avant de livrer.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const VERSION = "2.1.9";

const travail = mkdtempSync(join(tmpdir(), "helix-blender-empreintes-"));
try {
  const entree = join(travail, "entree.in");
  const sortie = join(travail, "sortie.txt");
  writeFileSync(entree, `mcp-for-blender==${VERSION}\n`);
  execFileSync("uv", [
    "pip", "compile", entree,
    "--universal", "--generate-hashes", "--only-binary", ":all:",
    "--python-version", "3.10", "--no-header", "--no-annotate", "-q", "-o", sortie,
  ], { stdio: ["ignore", "inherit", "inherit"] });
  const exigences = readFileSync(sortie, "utf8")
    .replace(/\\\n\s*/g, " ")
    .split("\n")
    .map((l) => l.replace(/\s+#.*$/, "").trim())
    .filter((l) => l && !l.startsWith("#") && !l.startsWith("-"));
  for (const ligne of exigences) {
    if (!/^[A-Za-z0-9._-]+==[^\s;]+/.test(ligne) || !/--hash=sha256:[0-9a-f]{64}/.test(ligne)) throw new Error(`ligne sans version figée ou sans empreinte : ${ligne}`);
  }

  // Licences, lues sur PyPI pour chaque paquet à sa version.
  const licences = {};
  for (const ligne of exigences) {
    const [, nom, version] = ligne.match(/^([A-Za-z0-9._-]+)==([^\s;]+)/);
    const reponse = await fetch(`https://pypi.org/pypi/${nom}/${version}/json`);
    const info = (await reponse.json()).info;
    const classe = (info.classifiers ?? []).filter((c) => c.startsWith("License")).map((c) => c.split("::").pop().trim());
    licences[`${nom}==${version}`] = info.license_expression || (info.license && info.license.length < 40 ? info.license : "") || classe.join(", ") || "inconnue";
  }

  // Le module complémentaire, tel que la roue épinglée le livre.
  const meta = await (await fetch(`https://pypi.org/pypi/mcp-for-blender/${VERSION}/json`)).json();
  const roue = meta.urls.find((u) => u.packagetype === "bdist_wheel");
  const octets = Buffer.from(await (await fetch(roue.url)).arrayBuffer());
  if (createHash("sha256").update(octets).digest("hex") !== roue.digests.sha256) throw new Error("la roue téléchargée n'a pas l'empreinte annoncée par PyPI");
  const fichierRoue = join(travail, "roue.whl");
  writeFileSync(fichierRoue, octets);
  const module = execFileSync("unzip", ["-p", fichierRoue, "blender_mcp/bundled/addon.py"]);
  const moduleSha256 = createHash("sha256").update(module).digest("hex");

  const cible = join(dirname(fileURLToPath(import.meta.url)), "..", "gateway", "src", "blender-paquets.json");
  const releve = new Date().toISOString().slice(0, 10);
  writeFileSync(cible, `${JSON.stringify({ releve, version: VERSION, python: "3.10 à 3.14", module: { chemin: "blender_mcp/bundled/addon.py", sha256: moduleSha256 }, licences, exigences }, null, 1)}\n`);
  console.log(`${exigences.length} exigences, module complémentaire ${moduleSha256}, écrits dans ${cible}`);
} finally {
  rmSync(travail, { recursive: true, force: true });
}
