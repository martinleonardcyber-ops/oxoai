/*
 * Mentions des composants tiers que l'application embarque (THIRD_PARTY_NOTICES.md).
 *
 *   node scripts/notices-tiers.mjs             réécrit la partie générée du fichier
 *   node scripts/notices-tiers.mjs --verifier  dit si elle est à jour (code 1 sinon)
 *
 * Pourquoi (seconde tournée de l'audit de la chaîne d'approvisionnement,
 * 28/09/2026) : esbuild et Vite fondent le code des bibliothèques dans
 * `dist-gateway/index.cjs` et dans l'interface construite, sans leurs fichiers
 * de licence. La licence MIT, comme BSD et ISC, demande pourtant que sa mention
 * accompagne « toute copie ». Les paquets de `dependencies` voyagent, eux,
 * avec leur dossier entier dans `app.asar` (relu dans le paquet macOS de la
 * 0.27.0 : 116 paquets, 116 fichiers de licence) : ils sont listés, sans
 * recopier leur texte.
 *
 * Le relevé se fait sur ce qui est vraiment construit, pas sur `package.json` :
 * `pg` et `pdfjs-dist` sont des dépendances de développement, et finissent
 * pourtant dans la passerelle et dans l'interface.
 *
 * Seule la partie entre les deux marqueurs est écrite ici ; le reste du fichier
 * (Electron, police, données, téléchargements, compatibilité) est rédigé à la
 * main.
 */
import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const RACINE = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FICHIER = join(RACINE, "THIRD_PARTY_NOTICES.md");
const DEBUT = "<!-- début de la partie générée par scripts/notices-tiers.mjs : ne pas modifier à la main -->";
const FIN = "<!-- fin de la partie générée -->";

/** Le dossier du paquet npm d'où vient un fichier construit (le plus profond `node_modules/<nom>`). */
function dossierDuPaquet(chemin) {
  const r = /node_modules\/((?:@[^/]+\/)?[^/]+)/g;
  let m;
  let dernier = null;
  while ((m = r.exec(chemin))) dernier = m;
  return dernier ? chemin.slice(0, dernier.index + dernier[0].length) : null;
}

async function paquetsDe(options) {
  const r = await build({ bundle: true, write: false, metafile: true, logLevel: "silent", absWorkingDir: RACINE, ...options });
  const dossiers = new Set();
  for (const entree of Object.keys(r.metafile.inputs)) {
    const d = dossierDuPaquet(entree);
    if (d) dossiers.add(resolve(RACINE, d));
  }
  return dossiers;
}

/** La passerelle, telle que `npm run build:gateway` la construit. */
async function passerelle() {
  const commun = { platform: "node", target: "node20", format: "cjs", external: ["pg-native"] };
  const a = await paquetsDe({ ...commun, entryPoints: ["gateway/src/index.ts"] });
  const b = await paquetsDe({ ...commun, entryPoints: ["gateway/tools/motdepasse.ts"] });
  return new Set([...a, ...b]);
}

/**
 * L'interface. Vite résout comme esbuild pour ce qui compte ici (les paquets
 * importés) ; les styles, images et polices ne portent pas de code npm.
 */
async function interfaceConstruite() {
  const alias = {
    name: "alias-et-ressources",
    setup(b) {
      b.onResolve({ filter: /^@\// }, (a) => b.resolve("./" + a.path.slice(2), { resolveDir: join(RACINE, "src"), kind: a.kind }));
      b.onResolve({ filter: /\?/ }, (a) => ({ path: a.path, external: true }));
    },
  };
  return paquetsDe({
    entryPoints: ["src/main.tsx"],
    platform: "browser",
    format: "esm",
    jsx: "automatic",
    define: { __OXOAI_VERSION__: '"0"' },
    loader: { ".css": "empty", ".png": "empty", ".svg": "empty", ".woff2": "empty", ".jpg": "empty", ".webp": "empty" },
    plugins: [alias],
  });
}

/** Les paquets que electron-builder range dans `app.asar` : ceux de `dependencies`, et leurs dépendances. */
function paquetsDeLApplication() {
  const sortie = execFileSync("npm", ["ls", "--omit=dev", "--all", "--parseable"], { cwd: RACINE, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  return new Set(sortie.trim().split("\n").slice(1).filter((d) => d.includes("node_modules")));
}

function lirePaquet(dossier) {
  const m = JSON.parse(readFileSync(join(dossier, "package.json"), "utf8"));
  const licence =
    typeof m.license === "string" ? m.license : m.license?.type ?? (Array.isArray(m.licenses) ? m.licenses.map((l) => l.type).join(" OR ") : "(non déclarée)");
  const fichiers = readdirSync(dossier).filter((f) => /^(licen[cs]e|copying|notice)(\b|[.-]|$)/i.test(f)).sort();
  /*
   * La licence de Vite recopie à sa suite celles des bibliothèques fondues
   * dans Vite lui-même (plus de 2 000 lignes), qui ne sont pas livrées avec
   * l'application : seule sa propre licence est reprise.
   */
  const textes = fichiers.map((f) => ({
    fichier: f,
    texte: readFileSync(join(dossier, f), "utf8").replace(/\r\n/g, "\n").split(/\n#+ Licenses of bundled dependencies/)[0].trim(),
  }));
  return { nom: m.name, version: m.version, licence, textes };
}

/** Paquets fondus dans le code construit, sans leur fichier de licence : texte recopié. */
function sectionTextes(titre, intro, paquets) {
  const lignes = [`### ${titre}`, "", intro, ""];
  for (const p of paquets) {
    lignes.push(`#### ${p.nom} ${p.version} (${p.licence})`, "");
    if (!p.textes.length) {
      lignes.push(`Le paquet ne contient pas de fichier de licence ; licence déclarée dans son \`package.json\` : ${p.licence}.`, "");
      continue;
    }
    for (const t of p.textes) {
      lignes.push(`\`${t.fichier}\` :`, "", "```text", t.texte.replace(/```/g, "'''"), "```", "");
    }
  }
  return lignes;
}

async function genere() {
  const vus = (dossiers) => [...dossiers].filter((d) => existsSync(join(d, "package.json"))).map(lirePaquet);
  const tri = (a, b) => a.nom.localeCompare(b.nom) || a.version.localeCompare(b.version);
  const unique = (liste) => [...new Map(liste.map((p) => [`${p.nom}@${p.version}`, p])).values()].sort(tri);

  const passe = unique(vus(await passerelle()));
  const ecran = unique(vus(await interfaceConstruite()));
  // Une petite part de ces outils finit dans ce qui est construit : les styles de base de Tailwind, l'amorce de chargement de Vite.
  const outils = unique(vus(["tailwindcss", "vite"].map((n) => join(RACINE, "node_modules", n))));
  const appli = unique(vus(paquetsDeLApplication()));

  const lignes = [DEBUT, ""];
  lignes.push(
    ...sectionTextes(
      "Passerelle (`dist-gateway/index.cjs`, `dist-gateway/motdepasse.cjs`)",
      `${passe.length} paquets, fondus par esbuild dans la passerelle.`,
      passe,
    ),
  );
  lignes.push(...sectionTextes("Interface construite (`dist/`)", `${ecran.length} paquets, fondus par Vite dans l'interface.`, ecran));
  lignes.push(...sectionTextes("Outils de construction dont une part est livrée", "Styles de base générés par Tailwind CSS ; amorce de chargement des modules écrite par Vite.", outils));

  const parLicence = {};
  for (const p of appli) parLicence[p.licence] = (parLicence[p.licence] ?? 0) + 1;
  lignes.push(
    "### Paquets livrés avec leur dossier dans `app.asar`",
    "",
    `${appli.length} paquets (\`npm ls --omit=dev --all\`) : ${Object.entries(parLicence)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([l, n]) => `${l} ${n}`)
      .join(", ")}. Chacun voyage avec son propre fichier de licence ; il n'est pas recopié ici.`,
    "",
    "| Paquet | Version | Licence |",
    "|---|---|---|",
    ...appli.map((p) => `| ${p.nom} | ${p.version} | ${p.licence} |`),
    "",
    FIN,
  );
  return lignes.join("\n");
}

const partie = await genere();
const actuel = existsSync(FICHIER) ? readFileSync(FICHIER, "utf8") : "";
const i = actuel.indexOf(DEBUT);
const j = actuel.indexOf(FIN);
if (i < 0 || j < i) {
  console.error("THIRD_PARTY_NOTICES.md : marqueurs de la partie générée introuvables.");
  process.exit(1);
}
const nouveau = actuel.slice(0, i) + partie + actuel.slice(j + FIN.length);
if (process.argv.includes("--verifier")) {
  if (nouveau !== actuel) {
    console.log("THIRD_PARTY_NOTICES.md n'est pas à jour : relancer `node scripts/notices-tiers.mjs`.");
    process.exit(1);
  }
  console.log("THIRD_PARTY_NOTICES.md à jour.");
} else {
  writeFileSync(FICHIER, nouveau);
  console.log(`THIRD_PARTY_NOTICES.md réécrit (${partie.length} caractères générés).`);
}
