/**
 * Les nouveautés d'une version, lues dans les notes des publications GitHub.
 *
 * Demandé par Medhi le 23/10/2026 : « quand il y a une mise à jour, une espèce
 * de patch intégré : les gens peuvent voir les nouveautés ». La fenêtre qui
 * propose une version montre ce qu'elle apporte (et ce qu'apportaient les
 * versions sautées), puis la nouvelle version, à son premier lancement, le
 * redit une fois.
 *
 * Ce module ne fait aucun appel réseau : il trie ce que l'API de GitHub rend
 * et nettoie le texte des notes (`body`), sans Electron, pour se vérifier seul
 * (scripts/essai-notes-version.mjs). Les appels sont dans miseAJour.cjs.
 *
 * Ce qui est gardé d'une note : le chapeau (le texte avant le premier titre)
 * et la section « What's new ». Les notes publiées depuis la 2026.927.4 ont
 * toutes cette forme (relevé du 23/10/2026 sur les 26 publications) : un
 * chapeau, « ## Downloads » (tableau des paquets, empreintes), « ## What's new »,
 * « ## Notes » (mode d'emploi de la mise à jour, extension VS Code). Plutôt
 * que de couper « de What's new jusqu'à Notes », on découpe la note en
 * sections de titre `#` ou `##` et on garde celle dont le titre dit
 * « nouveautés » : un ordre changé, une section ajoutée après, ou un « ## Notes »
 * absent ne font rien déborder. Une note sans cette section (les plus
 * anciennes, ou une écrite autrement) garde tout sauf les sections de
 * téléchargement, d'empreintes et de notes techniques.
 *
 * Rendu sûr : le texte rendu est du Markdown réduit (titres, listes, gras,
 * italique, code, liens), affiché par TexteRiche en nœuds texte React ; aucun
 * HTML n'est interprété. On retire quand même ici les balises, les
 * commentaires, le contenu des `<script>` et `<style>`, les tableaux, les
 * images, les caractères de contrôle et de direction, et les liens qui ne
 * sont pas en https : ils ne seraient de toute façon pas cliquables.
 */

/** Une note brute plus longue est coupée avant tout traitement (les vraies pèsent 2 à 4 Ko). */
const TAILLE_BRUTE_MAX = 64 * 1024;
/** Le texte gardé d'une version, au plus. */
const TAILLE_NOTE_MAX = 12 * 1024;
/** Versions sautées montrées au plus ; au-delà, un lien vers toutes les publications. */
const VERSIONS_MAX = 8;
/** Les langues de l'interface ; l'anglais est celui des notes GitHub. */
const LANGUES = ["fr", "en", "zh", "ja", "es", "de", "ar"];

const VERSION = /^v?(\d+)\.(\d+)\.(\d+)$/;

function lireVersion(v) {
  const m = VERSION.exec(String(v ?? "").trim());
  return m ? m.slice(1).map(Number) : null;
}

/** -1, 0 ou 1 ; null si l'une n'est pas un numéro de version. */
function comparer(a, b) {
  const x = lireVersion(a);
  const y = lireVersion(b);
  if (!x || !y) return null;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i] ? 1 : -1;
  return 0;
}

const versionValide = (v) => typeof v === "string" && v.length <= 32 && lireVersion(v) !== null;

/**
 * Retire tout ce qui va de `ouvre` à `ferme` (insensible à la casse), en un
 * seul passage : une expression paresseuse sur « <!-- » répété sans fin
 * reprendrait le texte depuis chaque ouverture.
 */
function retirerEntre(texte, ouvre, ferme) {
  const bas = texte.toLowerCase();
  let sortie = "";
  let i = 0;
  for (;;) {
    const debut = bas.indexOf(ouvre, i);
    if (debut < 0) return sortie + texte.slice(i);
    sortie += texte.slice(i, debut);
    const fin = bas.indexOf(ferme, debut + ouvre.length);
    if (fin < 0) return sortie;
    i = fin + ferme.length;
  }
}

/** Le texte, sans HTML ni caractère invisible, en sauts de ligne `\n`. */
function assainir(brut) {
  let s = String(brut ?? "");
  if (s.length > TAILLE_BRUTE_MAX) s = s.slice(0, TAILLE_BRUTE_MAX);
  s = s.replace(/\r\n?/g, "\n");
  // Contrôles (sauf saut de ligne et tabulation) et marques de direction : une note ne retourne pas l'écran.
  s = s.replace(/[\u0000-\u0008\u000B-\u001F\u007F-\u009F‎‏‪-‮⁦-⁩﻿]/g, "");
  s = retirerEntre(s, "<!--", "-->");
  s = retirerEntre(s, "<script", "</script>");
  s = retirerEntre(s, "<style", "</style>");
  // Balises : `[^<>]*` ne franchit pas un autre « < », le passage reste linéaire.
  s = s.replace(/<\/?[A-Za-z!?][^<>]*>/g, "");
  return s;
}

const TITRE = /^(#{1,2})\s+(.*?)\s*#*\s*$/;
const NOUVEAUTES = /what['’]?s\s+new|^new\b|changelog|^changes\b|nouveaut|quoi de neuf/i;
const ECARTEES = /^(downloads?|t[ée]l[ée]chargements?|install(ation)?|checksums?|sha-?256|notes?)\b/i;

/** La note en sections (titre `#` ou `##`) ; la première, sans titre, est le chapeau. */
function sections(texte) {
  const liste = [{ titre: null, lignes: [] }];
  let dansCode = false;
  for (const ligne of texte.split("\n")) {
    if (/^\s*```/.test(ligne)) dansCode = !dansCode;
    const t = dansCode ? null : TITRE.exec(ligne);
    if (t) liste.push({ titre: t[2], lignes: [] });
    else liste[liste.length - 1].lignes.push(ligne);
  }
  return liste;
}

/** Lignes affichables : ni tableau, ni image, ni lien hors https (gardé en texte). */
function lignesPropres(lignes) {
  const sortie = [];
  for (const ligne of lignes) {
    if (/^\s*\|/.test(ligne)) continue;
    if (/^\s*!\[[^\]]*\]\([^)]*\)\s*$/.test(ligne)) continue;
    sortie.push(
      ligne
        .replace(/!\[([^\]\n]*)\]\([^)\n]*\)/g, "$1")
        // Un niveau de parenthèses dans l'adresse (`javascript:alert(1)`, une page de Wikipédia) : sinon il en resterait un morceau.
        .replace(/\[([^\]\n]*)\]\(((?:[^()\s]|\([^()\s]*\))*)\)/g, (tout, texte, adresse) => (/^https:\/\/\S+$/i.test(adresse) ? tout : texte)),
    );
  }
  return sortie;
}

/** Bornée à TAILLE_NOTE_MAX, coupée en fin de ligne ; lignes vides en trop retirées. */
function finir(lignes) {
  let s = lignes.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  if (s.length > TAILLE_NOTE_MAX) {
    const coupe = s.lastIndexOf("\n", TAILLE_NOTE_MAX);
    s = `${s.slice(0, coupe > TAILLE_NOTE_MAX / 2 ? coupe : TAILLE_NOTE_MAX).trimEnd()}\n\n…`;
  }
  return s;
}

/**
 * Les nouveautés d'une note de publication GitHub (`body`), en Markdown
 * réduit : le chapeau, puis la section « What's new » ; sans elle, tout sauf
 * les sections écartées.
 */
function extraireNouveautes(body) {
  const parts = sections(assainir(body));
  const chapeau = parts[0].lignes;
  const nouveautes = parts.slice(1).find((p) => NOUVEAUTES.test(p.titre));
  const corps = nouveautes
    ? nouveautes.lignes
    : parts.slice(1).filter((p) => !ECARTEES.test(p.titre)).flatMap((p) => ["", `### ${p.titre}`, ...p.lignes]);
  return finir(lignesPropres([...chapeau, "", ...corps]));
}

/**
 * Une note traduite (`notes.<langue>.md`, jointe à la publication) : prise
 * entière, nettoyée de la même façon. Elle ne contient que les nouveautés
 * (PROJET.md, « Nouveautés de la version »).
 */
function extraireNoteTraduite(texte) {
  return finir(lignesPropres(assainir(texte).split("\n")));
}

/** La liste des publications rendue par l'API, ou null (illisible, autre chose qu'une liste). */
function lireListe(brut) {
  try {
    const liste = typeof brut === "string" ? JSON.parse(brut) : brut;
    return Array.isArray(liste) ? liste : null;
  } catch {
    return null;
  }
}

/**
 * Les publications à montrer, de la plus récente à la plus ancienne : la
 * version `jusqua`, et celles d'après `depuis` (exclue) jusqu'à elle. Sans
 * `depuis`, la seule `jusqua`. Ni brouillon ni préversion.
 */
function choisirPublications(liste, { depuis, jusqua }) {
  if (!versionValide(jusqua)) return { retenues: [], autres: 0 };
  const bonnes = (liste ?? []).filter(
    (p) => p && typeof p === "object" && !p.draft && !p.prerelease && versionValide(p.tag_name),
  );
  const dansLIntervalle = bonnes.filter((p) => {
    const v = String(p.tag_name).replace(/^v/, "");
    if (comparer(v, jusqua) === 1) return false;
    if (!depuis || !versionValide(depuis)) return comparer(v, jusqua) === 0;
    return comparer(v, depuis) === 1;
  });
  // Une même version publiée deux fois (« 1.2.3 » et « v1.2.3 ») : une seule.
  const vues = new Set();
  const uniques = dansLIntervalle.filter((p) => {
    const v = String(p.tag_name).replace(/^v/, "");
    if (vues.has(v)) return false;
    vues.add(v);
    return true;
  });
  uniques.sort((a, b) => comparer(String(b.tag_name).replace(/^v/, ""), String(a.tag_name).replace(/^v/, "")));
  return { retenues: uniques.slice(0, VERSIONS_MAX), autres: Math.max(0, uniques.length - VERSIONS_MAX) };
}

/**
 * La note traduite jointe à une publication, `notes.<langue>.md`, si elle a
 * une taille de note (celle que donne GitHub) et une adresse de GitHub en
 * https ; sinon null, et l'anglais s'affiche.
 */
function noteTraduiteDe(fichiers, langue) {
  if (!LANGUES.includes(langue) || langue === "en") return null;
  const f = (fichiers ?? []).find((x) => x && x.name === `notes.${langue}.md`);
  if (!f || !Number.isInteger(f.size) || f.size <= 0 || f.size > TAILLE_BRUTE_MAX) return null;
  return typeof f.browser_download_url === "string" && /^https:\/\/github\.com\//i.test(f.browser_download_url) ? f : null;
}

/** La page de la publication sur GitHub, seulement si c'en est une. */
function lienPublication(publication) {
  const u = publication && publication.html_url;
  return typeof u === "string" && /^https:\/\/github\.com\/[A-Za-z0-9-]+\/[A-Za-z0-9._-]+\/releases\/tag\/[\w.-]+$/.test(u) ? u : null;
}

/** La date de publication (ISO), ou null. */
function datePublication(publication) {
  const d = publication && publication.published_at;
  return typeof d === "string" && /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(d) ? d : null;
}

module.exports = {
  extraireNouveautes,
  extraireNoteTraduite,
  lireListe,
  choisirPublications,
  noteTraduiteDe,
  lienPublication,
  datePublication,
  versionValide,
  comparer,
  LANGUES,
  TAILLE_BRUTE_MAX,
  TAILLE_NOTE_MAX,
  VERSIONS_MAX,
};
