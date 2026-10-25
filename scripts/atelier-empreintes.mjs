/*
 * Paquets Python de l'atelier et de la dictée (gateway/src/atelier.ts), figés
 * avec leurs empreintes.
 *
 *   node scripts/atelier-empreintes.mjs
 *
 * Demande `uv` sur le poste de développement (github.com/astral-sh/uv) : c'est
 * lui qui résout, pour tous les systèmes et toutes les versions de Python d'un
 * coup (`--universal`, de 3.9, le Python livré par Apple, à 3.14), la liste
 * complète des paquets, dépendances comprises, et relève sur PyPI l'empreinte
 * SHA-256 de chacune de leurs roues. Le résultat est écrit dans
 * `gateway/src/atelier-paquets.json` ; la passerelle installe ensuite avec
 * `pip --require-hashes --no-deps --only-binary=:all:` : un paquet absent de la
 * liste, ou dont le fichier n'a pas l'une des empreintes relevées, est refusé.
 *
 * Pourquoi (audit de la chaîne d'approvisionnement du 27/09/2026) : l'atelier
 * installait `pip install --upgrade` de dix noms sans version, et la dictée
 * `faster-whisper>=1.1,<2` : la dernière publication de chacun, et de leurs
 * dépendances, au moment du clic, sans rien vérifier.
 *
 * La dictée est résolue avec l'atelier (même environnement Python) : les
 * paquets communs (numpy, Pillow…) ont la même version dans les deux listes.
 *
 * Pour changer de version : relancer ce script, relire le différentiel du
 * fichier JSON, et réessayer l'atelier et la dictée sur un poste avant de
 * livrer. Le contrôle « 14. Chaîne d'approvisionnement » de `npm run securite`
 * vérifie que chaque ligne est figée et porte au moins une empreinte.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Les bibliothèques de l'atelier : les mêmes noms que PAQUETS_PYTHON (atelier.ts). */
const BUREAUTIQUE = ["python-docx", "python-pptx", "openpyxl", "XlsxWriter", "pandas", "pypdf", "pdfplumber", "reportlab", "Pillow", "lxml"];
/** La dictée : la même borne que PAQUET_DICTEE (atelier.ts). */
const DICTEE = ["faster-whisper>=1.1,<2"];
/*
 * onnxruntime déclare Python 3.10 pour des versions qui n'ont plus de roue
 * cp310 (1.24), et aucune borne pour d'autres sans roue cp39 (1.20) : sans ces
 * bornes, la résolution retient une version qu'aucun Python 3.9 ou 3.10 ne
 * peut installer (relevé le 27/09/2026).
 */
const CONTRAINTES = ['onnxruntime<1.24 ; python_version == "3.10"', 'onnxruntime<1.20 ; python_version < "3.10"'];

const travail = mkdtempSync(join(tmpdir(), "oxoai-atelier-empreintes-"));
function resoudre(noms) {
  const entree = join(travail, "entree.in");
  const contraintes = join(travail, "contraintes.txt");
  const sortie = join(travail, "sortie.txt");
  writeFileSync(entree, `${noms.join("\n")}\n`);
  writeFileSync(contraintes, `${CONTRAINTES.join("\n")}\n`);
  execFileSync("uv", [
    "pip", "compile", entree, "-c", contraintes,
    "--universal", "--generate-hashes", "--only-binary", ":all:",
    "--python-version", "3.9", "--no-header", "--no-annotate", "-q", "-o", sortie,
  ], { stdio: ["ignore", "inherit", "inherit"] });
  // Une exigence par ligne : les suites (« \ ») sont recollées, les commentaires retirés.
  return readFileSync(sortie, "utf8")
    .replace(/\\\n\s*/g, " ")
    .split("\n")
    .map((l) => l.replace(/\s+#.*$/, "").trim())
    .filter((l) => l && !l.startsWith("#") && !l.startsWith("-"));
}

/*
 * Les bibliothèques Node de l'atelier (PAQUETS_NODE), à version exacte, et le
 * fichier de verrouillage de npm qui fige toutes leurs dépendances avec leur
 * empreinte (`integrity`) : l'atelier les pose par `npm ci`, qui refuse une
 * archive dont l'empreinte diffère. Format 2, lisible par npm 7 et suivants.
 */
const NODE = { docx: "9.7.2", pptxgenjs: "4.0.1", "@e965/xlsx": "0.20.3", mammoth: "1.13.0", "pdf-lib": "1.17.1", "pdfjs-dist": "6.3.289" };
function verrouNode() {
  const dossier = join(travail, "node");
  mkdirSync(dossier, { recursive: true });
  writeFileSync(join(dossier, "package.json"), JSON.stringify({ name: "oxoai-atelier", version: "1.0.0", private: true, dependencies: NODE }));
  execFileSync("npm", ["install", "--package-lock-only", "--ignore-scripts", "--lockfile-version", "2", "--no-audit", "--no-fund"], { cwd: dossier, stdio: ["ignore", "ignore", "inherit"] });
  const verrou = JSON.parse(readFileSync(join(dossier, "package-lock.json"), "utf8"));
  for (const [chemin, p] of Object.entries(verrou.packages ?? {})) {
    if (!chemin) continue;
    if (!p.integrity || !String(p.resolved ?? "").startsWith("https://registry.npmjs.org/")) throw new Error(`${chemin} : sans empreinte ou hors du registre npm`);
  }
  return verrou;
}

try {
  const node = { dependances: NODE, verrou: verrouNode() };
  const bureautique = resoudre(BUREAUTIQUE);
  const dictee = resoudre([...BUREAUTIQUE, ...DICTEE]);
  for (const ligne of [...bureautique, ...dictee]) {
    if (!/^[A-Za-z0-9._-]+==[^\s;]+/.test(ligne) || !/--hash=sha256:[0-9a-f]{64}/.test(ligne)) throw new Error(`ligne sans version figée ou sans empreinte : ${ligne}`);
  }
  // Ce qui est commun doit être identique : un même venv sert aux deux.
  const communes = bureautique.filter((l) => !dictee.includes(l));
  if (communes.length) throw new Error(`l'atelier et la dictée divergent :\n${communes.join("\n")}`);
  const cible = join(dirname(fileURLToPath(import.meta.url)), "..", "gateway", "src", "atelier-paquets.json");
  const releve = new Date().toISOString().slice(0, 10);
  writeFileSync(cible, `${JSON.stringify({ releve, python: "3.9 à 3.14", bureautique, dictee, node }, null, 1)}\n`);
  console.log(`${bureautique.length} exigences pour l'atelier, ${dictee.length} avec la dictée, ${Object.keys(node.verrou.packages).length - 1} paquets Node, écrits dans ${cible}`);
} finally {
  rmSync(travail, { recursive: true, force: true });
}
