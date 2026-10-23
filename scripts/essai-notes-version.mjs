/**
 * Vérifie les nouveautés d'une version (electron/notesVersion.cjs) et leur rendu
 * (src/components/ui/TexteRiche.tsx, `liens`), sans Electron ni réseau :
 * `node scripts/essai-notes-version.mjs`. 23/10/2026.
 *
 * Avec `--reseau`, lit en plus les vraies publications du dépôt (API GitHub) et
 * dit ce qui en sort ; jamais dans `npm run securite`.
 */
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const RACINE = join(dirname(fileURLToPath(import.meta.url)), "..");
const n = require("../electron/notesVersion.cjs");
let echecs = 0;
const verifier = (nom, ok, obtenu) => {
  console.log(`${ok ? "✓" : "✗"} ${nom}${ok ? "" : `  (obtenu : ${String(obtenu).slice(0, 300)})`}`);
  if (!ok) echecs++;
};

// Une note de la forme publiée depuis la 2026.927.4 : chapeau, Downloads, What's new, Notes.
const note = [
  "Helix AI 9.9.9 gives long Chats a memory.",
  "",
  "## Downloads",
  "",
  "| Platform | File | Installation |",
  "|---|---|---|",
  "| macOS (Apple Silicon) | `Helix-9.9.9-arm64.dmg` | Drag Helix to Applications |",
  "",
  "SHA-256 checksums are in `SHA256SUMS.txt`.",
  "",
  "## What's new",
  "",
  "- **Memory of a conversation.** Older messages are kept, see [the guide](https://github.com/medhiclb/HelixAI/blob/main/docs/GUIDE.md).",
  "- **First model download.** Resumed on the same model.",
  "",
  "2482 automated checks, 0 failures.",
  "",
  "## Notes",
  "",
  "- On macOS, choose \"Always Allow\" when asked for the keychain.",
].join("\r\n");
const extrait = n.extraireNouveautes(note);
verifier("chapeau gardé", extrait.startsWith("Helix AI 9.9.9 gives long Chats a memory."), extrait);
verifier("« What's new » gardé, gras et lien https compris", /\*\*Memory of a conversation\.\*\*/.test(extrait) && /\[the guide\]\(https:\/\/github\.com\//.test(extrait), extrait);
verifier("ni tableau ni section « Downloads »", !/\|/.test(extrait) && !/Downloads|SHA256SUMS|arm64\.dmg/.test(extrait), extrait);
verifier("section « Notes » écartée", !/keychain|## Notes/.test(extrait), extrait);
verifier("sauts de ligne Windows ramenés à \\n", !/\r/.test(extrait), JSON.stringify(extrait));

// L'ordre changé ne fait rien déborder : « Notes » avant « What's new », une section après.
const desordre = "Intro.\n\n## Notes\n\nnote technique\n\n## What's new\n\n- nouveauté\n\n## Thanks\n\nmerci";
const d = n.extraireNouveautes(desordre);
verifier("ordre changé : seulement la section des nouveautés", /nouveauté/.test(d) && !/note technique|merci/.test(d), d);

// Sans section « What's new » : tout sauf téléchargements, empreintes et notes.
const sans = "Intro.\n\n## Downloads\n\n| a | b |\n\n## Improvements\n\n- mieux\n\n## Checksums\n\nabc\n\n## Notes\n\nn";
const s = n.extraireNouveautes(sans);
verifier("sans « What's new » : les autres sections, avec leur titre", /### Improvements/.test(s) && /- mieux/.test(s) && !/Downloads|Checksums|abc|## Notes/.test(s), s);
verifier("un « ## » dans un bloc de code n'est pas un titre", /## pas un titre/.test(n.extraireNouveautes("## What's new\n\n```\n## pas un titre\n```\n- x")), n.extraireNouveautes("## What's new\n\n```\n## pas un titre\n```\n- x"));

// Rendu sûr : rien d'exécutable ne passe.
const piege = [
  "## What's new",
  "<script>alert('a')</script>",
  "<SCRIPT src=https://exemple.test/x.js></SCRIPT>",
  "<img src=x onerror=alert(1)>",
  "<style>body{display:none}</style>",
  "<!-- caché -->",
  "<details><summary>plus</summary>texte gardé</details>",
  "- [cliquer](javascript:alert(1))",
  "- [fichier](file:///etc/passwd)",
  "- [données](data:text/html;base64,PHNjcmlwdD4=)",
  "- [bon](https://github.com/medhiclb/HelixAI/releases)",
  "- ![image](https://exemple.test/i.png)",
  "- direction ‮esrever‬ et ⁦isolé⁩, contrôle \u0007",
].join("\n");
const p = n.extraireNouveautes(piege);
verifier("<script>, <style>, commentaires et balises retirés", !/<|alert\('a'\)|x\.js|display:none|caché|onerror/i.test(p), p);
verifier("le texte d'une balise ordinaire reste", /plus/.test(p) && /texte gardé/.test(p), p);
verifier("liens javascript:, file:, data: réduits à leur texte", /- cliquer$/m.test(p) && /- fichier$/m.test(p) && /- données$/m.test(p) && !/javascript:|file:|data:/i.test(p), p);
verifier("lien https gardé", /\[bon\]\(https:\/\/github\.com\/medhiclb\/HelixAI\/releases\)/.test(p), p);
verifier("image réduite à son texte, sans adresse", /- image$/m.test(p) && !/i\.png/.test(p), p);
verifier("caractères de direction et de contrôle retirés", !/[‪-‮⁦-⁩\u0007]/.test(p) && /esrever/.test(p), JSON.stringify(p));

// Taille bornée, et en temps linéaire même sur une note hostile.
const enorme = `## What's new\n\n${"- une ligne de nouveautés assez longue pour remplir\n".repeat(40_000)}`;
const e = n.extraireNouveautes(enorme);
verifier(`note de ${Math.round(enorme.length / 1024)} Ko bornée à ${n.TAILLE_NOTE_MAX} caractères, coupée en fin de ligne`, e.length <= n.TAILLE_NOTE_MAX + 4 && e.endsWith("…"), e.length);
const t0 = Date.now();
n.extraireNouveautes("<!--".repeat(100_000) + "<a".repeat(100_000) + "<script".repeat(50_000));
verifier("« <!-- », « <a » et « <script » répétés sans fin : traité en moins d'une seconde", Date.now() - t0 < 1000, `${Date.now() - t0} ms`);
verifier("note absente ou d'un autre type : texte vide", n.extraireNouveautes(undefined) === "" && n.extraireNouveautes(null) === "" && n.extraireNouveautes(42) === "42");

// Les versions montrées.
const pub = (tag, d = {}) => ({ tag_name: tag, body: `## What's new\n\n- ${tag}`, html_url: `https://github.com/medhiclb/HelixAI/releases/tag/${tag}`, published_at: "2026-10-16T15:53:28Z", assets: [], ...d });
const liste = [
  pub("v2026.1016.2"),
  pub("v2026.1016.1"),
  pub("v2026.1020.1", { prerelease: true }),
  pub("v2026.1018.1", { draft: true }),
  pub("v2026.1012.1"),
  pub("v2026.1004.2"),
  pub("v2026.1004.1"),
  pub("pas-une-version"),
  null,
  pub("v2026.1002.1"),
];
const c = n.choisirPublications(liste, { depuis: "2026.1004.1", jusqua: "2026.1016.2" });
verifier(
  "versions sautées, la plus récente d'abord, l'installée exclue, ni brouillon ni préversion",
  c.retenues.map((x) => x.tag_name).join(",") === "v2026.1016.2,v2026.1016.1,v2026.1012.1,v2026.1004.2" && c.autres === 0,
  c.retenues.map((x) => x.tag_name),
);
verifier("sans version précédente : la seule version demandée", n.choisirPublications(liste, { depuis: null, jusqua: "2026.1012.1" }).retenues.map((x) => x.tag_name).join() === "v2026.1012.1");
verifier("une version plus récente que celle proposée n'est pas montrée", !n.choisirPublications(liste, { depuis: "2026.1002.1", jusqua: "2026.1012.1" }).retenues.some((x) => x.tag_name === "v2026.1016.1"));
const beaucoup = Array.from({ length: 20 }, (_, i) => pub(`v2026.${1001 + i}.1`));
const b = n.choisirPublications(beaucoup, { depuis: "2026.1000.1", jusqua: "2026.1020.1" });
verifier(`au plus ${n.VERSIONS_MAX} versions, les autres comptées`, b.retenues.length === n.VERSIONS_MAX && b.autres === 20 - n.VERSIONS_MAX && b.retenues[0].tag_name === "v2026.1020.1", `${b.retenues.length} / ${b.autres}`);
verifier("version demandée mal formée : rien", n.choisirPublications(liste, { jusqua: "../../x" }).retenues.length === 0 && n.choisirPublications(liste, { jusqua: undefined }).retenues.length === 0);
verifier("doublon « 1.2.3 » et « v1.2.3 » : une seule", n.choisirPublications([pub("v1.2.3"), pub("1.2.3")], { jusqua: "1.2.3" }).retenues.length === 1);
verifier("liste illisible : null", n.lireListe("{") === null && n.lireListe('{"message":"Not Found"}') === null && Array.isArray(n.lireListe("[]")));

// La note traduite jointe à la publication.
const fichier = (name, size = 2000, url = `https://github.com/medhiclb/HelixAI/releases/download/v9.9.9/${name}`) => ({ name, size, browser_download_url: url });
verifier("note traduite trouvée pour la langue de l'écran", n.noteTraduiteDe([fichier("notes.fr.md"), fichier("notes.de.md")], "fr")?.name === "notes.fr.md");
verifier("anglais : jamais de note jointe (c'est le texte de la publication)", n.noteTraduiteDe([fichier("notes.en.md")], "en") === null);
verifier("note traduite trop lourde, hors de GitHub, ou langue inconnue : écartée", n.noteTraduiteDe([fichier("notes.fr.md", 10 * 1024 * 1024)], "fr") === null && n.noteTraduiteDe([fichier("notes.fr.md", 2000, "https://exemple.test/notes.fr.md")], "fr") === null && n.noteTraduiteDe([fichier("notes.xx.md")], "xx") === null && n.noteTraduiteDe([fichier("notes.fr.md", null)], "fr") === null);
verifier("note traduite nettoyée comme l'autre", !/<script|javascript:/i.test(n.extraireNoteTraduite("# Nouveautés\n<script>x()</script>\n- [a](javascript:x)")));
verifier("page de la publication : GitHub seulement", n.lienPublication(pub("v1.0.0")) === "https://github.com/medhiclb/HelixAI/releases/tag/v1.0.0" && n.lienPublication({ html_url: "javascript:alert(1)" }) === null && n.lienPublication({ html_url: "https://exemple.test/releases/tag/v1" }) === null);
verifier("date de publication lue, sinon null", n.datePublication(pub("v1.0.0")) === "2026-10-16T15:53:28Z" && n.datePublication({ published_at: "<b>" }) === null);

// Le rendu par TexteRiche, construit comme l'interface (esbuild), en HTML statique.
{
  const dossier = mkdtempSync(join(tmpdir(), "helix-notes-"));
  try {
    const { build } = await import("esbuild");
    await build({
      stdin: {
        contents: 'export { TexteRiche } from "./src/components/ui/TexteRiche.tsx"; export { renderToStaticMarkup } from "react-dom/server"; export { createElement } from "react";',
        resolveDir: RACINE,
        loader: "ts",
      },
      bundle: true,
      format: "cjs",
      platform: "node",
      jsx: "automatic",
      outfile: join(dossier, "rendu.cjs"),
      alias: { "@": join(RACINE, "src") },
      define: { "process.env.NODE_ENV": '"production"' },
      logLevel: "error",
    });
    const { TexteRiche, renderToStaticMarkup, createElement } = require(join(dossier, "rendu.cjs"));
    const rendre = (texte, liens) => renderToStaticMarkup(createElement(TexteRiche, { texte, liens }));
    // Le texte brut, sans le nettoyage de notesVersion.cjs : le rendu tient seul.
    const brut = "### Titre\n<script>alert(1)</script>\n- [x](javascript:alert(1))\n- [y](JaVaScRiPt:alert(1))\n- [z](https://github.com/medhiclb/HelixAI) et **gras**\n- [w](https://exemple.test/a\"onmouseover=\"alert(1))";
    const html = rendre(brut, true);
    verifier("rendu : aucune balise <script> produite (le texte est échappé)", !/<script/i.test(html) && /&lt;script&gt;/.test(html), html);
    verifier("rendu : aucun href javascript:", !/href="\s*javascript:/i.test(html) && (html.match(/<a /g) ?? []).length === 2, html);
    verifier("rendu : lien https ouvert hors de l'application (target=_blank, noopener)", /<a href="https:\/\/github\.com\/medhiclb\/HelixAI" target="_blank" rel="noreferrer noopener"/.test(html), html);
    verifier("rendu : un guillemet dans l'adresse ne sort pas de l'attribut", !/onmouseover="/.test(html), html);
    verifier("rendu : titres, listes et gras mis en forme", /<ul/.test(html) && /<strong[^>]*>gras<\/strong>/.test(html) && /font-semibold[^>]*>Titre</.test(html), html);
    verifier("rendu du Chat inchangé : sans `liens`, aucun lien cliquable", !/<a /.test(rendre(brut, false)), rendre(brut, false));
    const chaine = rendre(n.extraireNouveautes(piege), true);
    verifier("note piégée nettoyée puis rendue : un seul lien, en https", (chaine.match(/<a /g) ?? []).length === 1 && !/javascript:|file:|data:|<script|<img|<style/i.test(chaine), chaine);
  } finally {
    rmSync(dossier, { recursive: true, force: true });
  }
}

/*
 * electron/miseAJour.cjs joué hors d'Electron (doublure, comme
 * scripts/doublure-mise-a-jour.cjs) : les canaux des nouveautés, le repère du
 * premier lancement, et ce qui se passe hors ligne, avec une liste trop
 * lourde, ou quand la mise à jour est coupée.
 */
{
  const Module = require("node:module");
  const { mkdirSync, writeFileSync, readFileSync, existsSync } = await import("node:fs");
  const AUX = mkdtempSync(join(tmpdir(), "helix-nouveautes-"));
  const profil = join(AUX, "profil");
  mkdirSync(join(AUX, "ressources"), { recursive: true });
  process.resourcesPath = join(AUX, "ressources");
  process.env.HELIX_DATA_DIR = join(AUX, "donnees");
  let routeur = async () => new Response("", { status: 404 });
  const canaux = {};
  const appels = [];
  const faux = {
    app: { getVersion: () => "9.0.0", isPackaged: true, getPath: () => profil, quit: () => {} },
    BrowserWindow: { getAllWindows: () => [] },
    ipcMain: { handle: (canal, fn) => (canaux[canal] = fn) },
    shell: { openExternal: async () => {} },
    net: { fetch: (url, o) => (appels.push(String(url)), routeur(String(url), o)) },
    safeStorage: { isEncryptionAvailable: () => false },
  };
  const charger = Module._load;
  Module._load = function (demande, ...reste) {
    return demande === "electron" ? faux : charger.call(this, demande, ...reste);
  };
  const chemin = join(RACINE, "electron", "miseAJour.cjs");
  const neuf = () => {
    delete require.cache[require.resolve(chemin)];
    return require(chemin);
  };
  const corps = (tag, d = {}) => ({
    tag_name: tag,
    draft: false,
    prerelease: false,
    html_url: `https://github.com/medhiclb/HelixAI/releases/tag/${tag}`,
    published_at: "2026-10-23T08:00:00Z",
    body: `Intro ${tag}.\n\n## Downloads\n\n| a | b |\n\n## What's new\n\n- nouveauté de ${tag}\n<script>alert(1)</script>\n\n## Notes\n\n- note`,
    assets: [],
    ...d,
  });
  const fr = { name: "notes.fr.md", size: 60, browser_download_url: "https://github.com/medhiclb/HelixAI/releases/download/v9.0.0/notes.fr.md" };
  const liste = [corps("v9.0.0", { assets: [fr] }), corps("v8.9.1"), corps("v8.9.0"), corps("v9.1.0", { prerelease: true })];
  routeur = async (url) => {
    if (url.includes("/releases?per_page=")) return new Response(JSON.stringify(liste));
    if (url.endsWith("/notes.fr.md")) return new Response("- **Mémoire** des conversations\n<img src=x onerror=alert(1)>");
    return new Response("", { status: 404 });
  };

  // Personne n'a encore donné la règle des canaux : refusé.
  let m = neuf();
  let refuse = false;
  try {
    await canaux["helix:maj-nouveautes"]({}, { jusqua: "9.0.0", langue: "en" });
  } catch {
    refuse = true;
  }
  verifier("canal des nouveautés refusé tant que la fenêtre principale n'est pas reconnue", refuse);
  await m.demarrerMiseAJour(() => true);

  // Installation neuve : rien à montrer, le repère est posé.
  let l = m.releverLancement();
  verifier("installation neuve : pas de fenêtre de nouveautés, repère posé", !l.depuis && !l.inconnue && JSON.parse(readFileSync(join(profil, "nouveautes.json"), "utf8")).vue === "9.0.0", JSON.stringify(l));

  // Profil déjà servi par une version d'avant ce repère : les nouveautés de la version installée.
  rmSync(join(profil, "nouveautes.json"));
  mkdirSync(join(profil, "Local Storage"), { recursive: true });
  m = neuf();
  await m.demarrerMiseAJour(() => true);
  l = await canaux["helix:maj-lancement"]({});
  verifier("profil d'avant le repère : mise à jour reconnue, version précédente inconnue", l.inconnue && !l.depuis, JSON.stringify(l));

  // Mise à jour depuis 8.9.0 : les versions sautées, la plus récente d'abord.
  writeFileSync(join(profil, "nouveautes.json"), JSON.stringify({ vue: "8.9.0", nePlusAfficher: false }));
  m = neuf();
  await m.demarrerMiseAJour(() => true);
  l = await canaux["helix:maj-lancement"]({});
  verifier("mise à jour depuis 8.9.0 reconnue", l.depuis === "8.9.0" && l.version === "9.0.0", JSON.stringify(l));
  const r = await canaux["helix:maj-nouveautes"]({}, { depuis: l.depuis, jusqua: l.version, langue: "en" });
  verifier(
    "nouveautés de 9.0.0 et 8.9.1, sans 8.9.0 (installée) ni la préversion, sans tableau ni script",
    r.ok && r.versions.map((v) => v.version).join() === "9.0.0,8.9.1" && r.versions.every((v) => !/\||<script|Downloads|## Notes/.test(v.texte) && /nouveauté de v/.test(v.texte)),
    JSON.stringify(r).slice(0, 400),
  );
  verifier("une seule lecture de la liste pour deux demandes (gardée une demi-heure)", (await canaux["helix:maj-nouveautes"]({}, { jusqua: "9.0.0", langue: "en" })).ok && appels.filter((a) => a.includes("/releases?")).length === 1, appels.join(" "));
  const rf = await canaux["helix:maj-nouveautes"]({}, { depuis: "8.9.0", jusqua: "9.0.0", langue: "fr" });
  verifier(
    "écran en français : la note `notes.fr.md` jointe est prise pour 9.0.0, nettoyée ; l'anglais pour 8.9.1",
    rf.ok && rf.versions[0].langue === "fr" && /Mémoire/.test(rf.versions[0].texte) && !/<img|onerror/.test(rf.versions[0].texte) && rf.versions[1].langue === "en",
    JSON.stringify(rf).slice(0, 400),
  );
  verifier("demande mal formée : rien n'est lu", !(await canaux["helix:maj-nouveautes"]({}, { jusqua: "../../etc", langue: "fr" })).ok && !(await canaux["helix:maj-nouveautes"]({}, null)).ok);

  // Vue, avec « Ne plus afficher » : le lancement suivant ne montre rien et garde le réglage.
  await canaux["helix:maj-nouveautes-vues"]({}, { nePlusAfficher: true });
  m = neuf();
  await m.demarrerMiseAJour(() => true);
  l = await canaux["helix:maj-lancement"]({});
  verifier("« Ne plus afficher » gardé, et plus rien à montrer pour cette version", l.nePlusAfficher && !l.depuis && !l.inconnue, JSON.stringify(l));

  // Hors ligne : pas de notes, mais la page des publications.
  m = neuf();
  await m.demarrerMiseAJour(() => true);
  routeur = async () => {
    throw new Error("net::ERR_INTERNET_DISCONNECTED");
  };
  const h = await canaux["helix:maj-nouveautes"]({}, { jusqua: "9.0.0", langue: "en" });
  verifier("hors ligne : rien ne casse, un lien vers la page des publications", !h.ok && h.lien === "https://github.com/medhiclb/HelixAI/releases", JSON.stringify(h));

  // Une liste qui n'en finit pas : refusée sans tout lire.
  m = neuf();
  await m.demarrerMiseAJour(() => true);
  routeur = async () => new Response(new ReadableStream({ pull(c) { c.enqueue(new Uint8Array(1024 * 1024).fill(32)); } }));
  const g = await canaux["helix:maj-nouveautes"]({}, { jusqua: "9.0.0", langue: "en" });
  verifier("liste de publications sans fin : refusée au-delà de 4 Mo, rien ne casse", !g.ok && g.lien, JSON.stringify(g));

  // Mise à jour coupée : GitHub n'est pas contacté.
  process.env.HELIX_SANS_MISE_A_JOUR = "1";
  m = neuf();
  await m.demarrerMiseAJour(() => true);
  appels.length = 0;
  const c = await canaux["helix:maj-nouveautes"]({}, { jusqua: "9.0.0", langue: "en" });
  verifier("HELIX_SANS_MISE_A_JOUR=1 : aucune note lue, aucun lien, rien contacté", !c.ok && c.lien === null && appels.length === 0, JSON.stringify(c));
  delete process.env.HELIX_SANS_MISE_A_JOUR;

  // Paquet qui porte le serveur de l'agence : pas GitHub.
  m = neuf();
  await m.demarrerMiseAJour(() => true);
  writeFileSync(join(AUX, "ressources", "app-update.yml"), "provider: generic\nurl: https://maj.exemple.test/helix\n");
  appels.length = 0;
  const a = await canaux["helix:maj-nouveautes"]({}, { jusqua: "9.0.0", langue: "en" });
  verifier("serveur de l'agence inscrit : GitHub n'est pas contacté pour les notes", !a.ok && a.lien === null && appels.length === 0, JSON.stringify(a));
  Module._load = charger;
  verifier("le repère du profil n'est jamais écrit ailleurs que dans le profil", existsSync(join(profil, "nouveautes.json")) && !existsSync(join(AUX, "donnees", "nouveautes.json")));
  rmSync(AUX, { recursive: true, force: true });
}

if (process.argv.includes("--reseau")) {
  const depot = require("../package.json").depotMisesAJour;
  const r = await fetch(`https://api.github.com/repos/${depot}/releases?per_page=30`, { headers: { Accept: "application/vnd.github+json", "User-Agent": "Helix" } });
  const vraies = n.lireListe(await r.text()) ?? [];
  console.log(`\n${vraies.length} publications lues sur ${depot}`);
  for (const v of vraies) {
    const x = n.extraireNouveautes(v.body);
    const ok = x.length > 0 && !/\|/.test(x) && !/## Downloads|## Notes/.test(x);
    verifier(`${v.tag_name} : ${x.length} caractères, sans tableau ni « Downloads »`, ok, x.slice(0, 200));
  }
  const derniere = vraies.find((v) => !v.draft && !v.prerelease);
  if (derniere) console.log(`\n--- ${derniere.tag_name}\n${n.extraireNouveautes(derniere.body)}\n---`);
}

console.log(echecs ? `${echecs} échec(s)` : "tout est bon");
process.exit(echecs ? 1 : 0);
