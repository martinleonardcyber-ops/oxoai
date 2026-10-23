import { t, tf } from "@/lib/i18n";
import { lireEntree, repertoire } from "@/lib/importChats";
import { BORNES, nomDeFichierValide, problemeCompetence, type Competence, type FichierCompetence } from "@/lib/store/competences";

/**
 * Importer et exporter une compétence en fichier (23/10/2026).
 *
 * ── Le format ──────────────────────────────────────────────────────────────
 *
 * Celui qui s'est répandu sous le nom de « SKILL.md » : un dossier qui porte
 * un fichier `SKILL.md`, avec un en-tête YAML (`name`, `description`), puis
 * les instructions en Markdown, et d'éventuels fichiers à côté (modèles,
 * exemples, parfois des scripts). Correspondance :
 *
 *   name          → identifiant en minuscules et tirets (le nom affiché est
 *                   le titre `# …` qui ouvre le texte, s'il y en a un)
 *   description   → « Quand s'en servir »
 *   le texte      → la manière de faire
 *   les fichiers  → les fichiers joints, en texte
 *
 * L'export rend une archive ZIP `<nom>/SKILL.md` (+ fichiers joints), lisible
 * par les outils qui acceptent ce format. L'import accepte cette archive, un
 * fichier `.md` seul, ou plusieurs fichiers choisis ensemble (le `SKILL.md`
 * et ses voisins).
 *
 * ── Ce qui ne se fait jamais ───────────────────────────────────────────────
 *
 * Rien d'une compétence importée ne s'exécute : ce module lit du texte et
 * rend du texte. Un script joint devient un fichier joint, que le modèle
 * reçoit à lire (gateway/src/competencesRegles.ts le lui dit). Les champs de
 * l'en-tête qui donneraient des droits (`allowed-tools`, …) sont ignorés, et
 * l'aperçu le dit. Rien n'est enregistré avant que la personne ait vu le
 * contenu et accepté (CompetencesReglages.tsx).
 */

export interface LectureCompetence {
  nom: string;
  quand: string;
  instructions: string;
  fichiers: FichierCompetence[];
  /** Ce que la personne doit savoir avant d'accepter. */
  avertissements: string[];
  /** Ce qui empêche l'import, ou null. */
  probleme: string | null;
}

/** Taille d'un fichier choisi au-delà de laquelle on ne le lit même pas (une archive de compétence pèse quelques kilo-octets). */
const FICHIER_CHOISI_MAX = 5 * 1024 * 1024;

/* ---- En-tête YAML, juste ce qu'il faut ------------------------------------ */

function sansGuillemets(v: string): string {
  const s = v.trim();
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1).replace(/\\"/g, '"').replace(/''/g, "'");
  }
  return s;
}

/** Les clés de premier niveau d'un en-tête YAML simple : valeur sur la ligne, ou bloc `|` / `>` indenté. */
export function lireEnTete(yaml: string): Record<string, string> {
  const lignes = yaml.split(/\r?\n/);
  const sortie: Record<string, string> = {};
  for (let i = 0; i < lignes.length; i++) {
    const m = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(lignes[i]!);
    if (!m) continue;
    const cle = m[1]!;
    const valeur = m[2]!;
    if (/^[|>][+-]?$/.test(valeur.trim())) {
      const bloc: string[] = [];
      while (i + 1 < lignes.length && (/^\s+\S/.test(lignes[i + 1]!) || lignes[i + 1]!.trim() === "")) bloc.push(lignes[++i]!.trim());
      sortie[cle] = valeur.trim().startsWith(">") ? bloc.join(" ").replace(/\s+/g, " ").trim() : bloc.join("\n").trim();
    } else if (valeur.trim() === "") {
      // Une liste ou un objet (metadata, allowed-tools) : la clé est notée, son contenu sauté.
      while (i + 1 < lignes.length && /^\s+/.test(lignes[i + 1]!)) i++;
      sortie[cle] = "";
    } else {
      sortie[cle] = sansGuillemets(valeur);
    }
  }
  return sortie;
}

/** Coupe à `max` caractères au dernier espace, pour la phrase « quand » seulement (jamais la manière de faire). */
function couperPhrase(texte: string, max: number): string {
  if (texte.length <= max) return texte;
  const coupe = texte.slice(0, max - 1);
  const espace = coupe.lastIndexOf(" ");
  return `${(espace > max / 2 ? coupe.slice(0, espace) : coupe).trimEnd()}…`;
}

/** « compte-rendu-de-reunion » → « Compte rendu de reunion ». */
function nomDepuisIdentifiant(id: string): string {
  const s = id.replace(/[-_]+/g, " ").trim();
  return s ? s.charAt(0).toLocaleUpperCase("fr") + s.slice(1) : "";
}

/** Lit le texte d'un SKILL.md (ou de tout Markdown). */
export function lireSkillMd(texte: string): LectureCompetence {
  const avertissements: string[] = [];
  let corps = texte.replace(/^﻿/, "");
  let entete: Record<string, string> = {};
  const m = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(corps);
  if (m) {
    entete = lireEnTete(m[1]!);
    corps = corps.slice(m[0].length);
  }
  corps = corps.trim();
  let nom = "";
  const titre = /^#\s+(.+)\r?\n?/.exec(corps);
  if (titre) {
    nom = titre[1]!.trim();
    corps = corps.slice(titre[0].length).trim();
  }
  if (!nom) nom = nomDepuisIdentifiant(entete.name ?? "");
  if (nom.length > BORNES.nom) nom = couperPhrase(nom, BORNES.nom);
  let quand = (entete.description ?? "").replace(/\s+/g, " ").trim();
  if (quand.length > BORNES.quand) {
    quand = couperPhrase(quand, BORNES.quand);
    avertissements.push(t("La description était plus longue que la phrase « quand s'en servir » : elle a été raccourcie, relisez-la."));
  }
  const ignores = Object.keys(entete).filter((k) => k !== "name" && k !== "description");
  if (ignores.length > 0) {
    avertissements.push(tf("Champs de l'en-tête ignorés : {0}. Une compétence ne donne aucun droit ni aucun outil.", ignores.join(", ")));
  }
  const lecture: LectureCompetence = { nom, quand, instructions: corps, fichiers: [], avertissements, probleme: null };
  if (!m && !titre) avertissements.push(t("Ce fichier n'a pas d'en-tête SKILL.md (name, description) : vérifiez le nom et la phrase « quand s'en servir »."));
  lecture.probleme = problemeCompetence({ ...lecture, quand: lecture.quand });
  return lecture;
}

/* ---- Code dans les fichiers joints : dit, jamais exécuté ------------------ */

const EXTENSIONS_CODE = /\.(py|sh|bash|zsh|js|mjs|cjs|ts|rb|pl|php|ps1|bat|cmd|exe|applescript|scpt)$/i;

/** Le contenu ressemble-t-il à du binaire ? On ne joint que du texte. */
function binaire(texte: string): boolean {
  if (texte.includes("\u0000")) return true;
  const remplaces = (texte.match(/�/g) ?? []).length;
  return remplaces > 8 && remplaces > texte.length / 200;
}

/** Joint un fichier texte à une lecture, ou dit pourquoi il est laissé de côté. */
function joindre(lecture: LectureCompetence, nomBrut: string, contenu: string | null): void {
  let nom = nomBrut.split(/[\\/]/).pop()!.trim();
  if (!nomDeFichierValide(nom)) {
    lecture.avertissements.push(tf("« {0} » laissé de côté : nom de fichier invalide.", nomBrut));
    return;
  }
  if (contenu === null || contenu.length > BORNES.fichier) {
    lecture.avertissements.push(tf("« {0} » laissé de côté : trop grand pour un fichier joint.", nom));
    return;
  }
  if (binaire(contenu)) {
    lecture.avertissements.push(tf("« {0} » laissé de côté : ce n'est pas du texte.", nom));
    return;
  }
  if (lecture.fichiers.length >= BORNES.fichiers) {
    lecture.avertissements.push(tf("« {0} » laissé de côté : cinq fichiers joints au plus.", nom));
    return;
  }
  // Deux fichiers du même nom dans deux sous-dossiers : le second est renommé.
  let n = 2;
  const base = nom;
  while (lecture.fichiers.some((f) => f.nom === nom)) nom = `${base} (${n++})`;
  if (EXTENSIONS_CODE.test(nom)) {
    lecture.avertissements.push(tf("« {0} » contient du code : il sera seulement donné à lire au modèle, jamais exécuté.", nom));
  }
  lecture.fichiers.push({ nom, contenu });
}

/* ---- Lire ce que la personne a choisi ------------------------------------ */

const estSkillMd = (chemin: string) => /(^|\/)skill\.md$/i.test(chemin);

/** Une archive ZIP : le SKILL.md le moins profond, et les fichiers de son dossier. */
async function lireArchive(f: File): Promise<LectureCompetence> {
  let entrees;
  try {
    entrees = await repertoire(f);
  } catch {
    return echec(t("Cette archive n'est pas lisible."));
  }
  const fichiers = entrees.filter((e) => !e.nom.endsWith("/") && !/(^|\/)(__MACOSX|\.DS_Store)/.test(e.nom));
  const candidats = fichiers.filter((e) => estSkillMd(e.nom)).sort((a, b) => a.nom.split("/").length - b.nom.split("/").length);
  const principal = candidats[0] ?? (fichiers.filter((e) => /\.md$/i.test(e.nom)).length === 1 ? fichiers.find((e) => /\.md$/i.test(e.nom)) : undefined);
  if (!principal) return echec(t("L'archive ne contient pas de fichier SKILL.md."));
  const texte = await lireEntree(f, principal, BORNES.instructions * 4 + 4096).catch(() => null);
  if (texte === null) return echec(t("Le fichier SKILL.md de l'archive est trop grand ou illisible."));
  const lecture = lireSkillMd(texte);
  const dossier = principal.nom.includes("/") ? principal.nom.slice(0, principal.nom.lastIndexOf("/") + 1) : "";
  for (const e of fichiers) {
    if (e === principal || !e.nom.startsWith(dossier)) continue;
    const contenu = await lireEntree(f, e, BORNES.fichier * 4).catch(() => null);
    joindre(lecture, e.nom.slice(dossier.length), contenu !== null && contenu.length <= BORNES.fichier ? contenu : null);
  }
  if (candidats.length > 1) lecture.avertissements.push(t("L'archive contient plusieurs compétences : seule la première est lue."));
  lecture.probleme = problemeCompetence(lecture);
  return lecture;
}

function echec(probleme: string): LectureCompetence {
  return { nom: "", quand: "", instructions: "", fichiers: [], avertissements: [], probleme };
}

/**
 * Lit les fichiers choisis : une archive ZIP, un `.md`, ou un SKILL.md et ses
 * voisins choisis ensemble. Ne fait que lire : rien n'est enregistré ici.
 */
export async function lireFichiersCompetence(choisis: File[]): Promise<LectureCompetence> {
  if (choisis.length === 0) return echec(t("Aucun fichier choisi."));
  if (choisis.some((f) => f.size > FICHIER_CHOISI_MAX)) return echec(t("Ce fichier est trop grand pour une compétence."));
  const archive = choisis.find((f) => /\.zip$/i.test(f.name) || f.type === "application/zip");
  if (archive) {
    const lecture = await lireArchive(archive);
    if (choisis.length > 1) lecture.avertissements.push(t("Une archive a été choisie : les autres fichiers ont été laissés de côté."));
    return lecture;
  }
  const principal =
    choisis.find((f) => estSkillMd(f.name)) ?? (choisis.filter((f) => /\.(md|markdown|txt)$/i.test(f.name))[0] ?? choisis[0]!);
  const lecture = lireSkillMd(await principal.text());
  for (const f of choisis) {
    if (f === principal) continue;
    joindre(lecture, f.name, f.size <= BORNES.fichier * 4 ? await f.text() : null);
  }
  lecture.probleme = problemeCompetence(lecture);
  return lecture;
}

/* ---- Exporter ------------------------------------------------------------- */

/** L'identifiant du format : minuscules, chiffres et tirets, 64 caractères au plus. */
export function identifiantDe(nom: string): string {
  const id = nom
    .toLocaleLowerCase("fr")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/-+$/g, "");
  return id || "competence";
}

/** Une valeur YAML sur une ligne, entre guillemets. */
const yaml = (v: string) => `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\s+/g, " ").trim()}"`;

export function versSkillMd(c: Pick<Competence, "nom" | "quand" | "instructions">): string {
  return ["---", `name: ${identifiantDe(c.nom)}`, `description: ${yaml(c.quand || c.nom)}`, "---", "", `# ${c.nom}`, "", c.instructions.trim(), ""].join("\n");
}

/* CRC-32, pour l'archive (méthode « stockée », sans compression : quelques kilo-octets). */
const TABLE_CRC = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();
function crc32(octets: Uint8Array): number {
  let c = 0xffffffff;
  for (const o of octets) c = TABLE_CRC[(c ^ o) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Une archive ZIP minimale, fichiers stockés, noms en UTF-8. */
export function archiveZip(fichiers: { chemin: string; contenu: string }[]): Blob {
  const enc = new TextEncoder();
  const morceaux: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let decalage = 0;
  for (const f of fichiers) {
    const nom = enc.encode(f.chemin);
    const donnees = enc.encode(f.contenu);
    const crc = crc32(donnees);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(6, 0x0800, true); // noms en UTF-8
    local.setUint16(8, 0, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, donnees.length, true);
    local.setUint32(22, donnees.length, true);
    local.setUint16(26, nom.length, true);
    morceaux.push(new Uint8Array(local.buffer), nom, donnees);
    const c = new DataView(new ArrayBuffer(46));
    c.setUint32(0, 0x02014b50, true);
    c.setUint16(4, 20, true);
    c.setUint16(6, 20, true);
    c.setUint16(8, 0x0800, true);
    c.setUint32(16, crc, true);
    c.setUint32(20, donnees.length, true);
    c.setUint32(24, donnees.length, true);
    c.setUint16(28, nom.length, true);
    c.setUint32(42, decalage, true);
    central.push(new Uint8Array(c.buffer), nom);
    decalage += 30 + nom.length + donnees.length;
  }
  const tailleCentral = central.reduce((n, m) => n + m.length, 0);
  const fin = new DataView(new ArrayBuffer(22));
  fin.setUint32(0, 0x06054b50, true);
  fin.setUint16(8, fichiers.length, true);
  fin.setUint16(10, fichiers.length, true);
  fin.setUint32(12, tailleCentral, true);
  fin.setUint32(16, decalage, true);
  return new Blob([...morceaux, ...central, new Uint8Array(fin.buffer)] as BlobPart[], { type: "application/zip" });
}

/** L'archive d'une compétence : `<identifiant>/SKILL.md`, et ses fichiers joints à côté. */
export function archiveDeCompetence(c: Competence): { nom: string; fichier: Blob } {
  const id = identifiantDe(c.nom);
  const fichier = archiveZip([
    { chemin: `${id}/SKILL.md`, contenu: versSkillMd(c) },
    ...(c.fichiers ?? []).map((f) => ({ chemin: `${id}/${f.nom}`, contenu: f.contenu })),
  ]);
  return { nom: `${id}.zip`, fichier };
}

/** Propose le fichier au téléchargement, comme l'export des données (exportDonnees.ts). */
export function telechargerCompetence(c: Competence): void {
  const { nom, fichier } = archiveDeCompetence(c);
  const adresse = URL.createObjectURL(fichier);
  const lien = document.createElement("a");
  lien.href = adresse;
  lien.download = nom;
  document.body.appendChild(lien);
  lien.click();
  lien.remove();
  setTimeout(() => URL.revokeObjectURL(adresse), 60_000);
}
