import { Fragment, type ReactNode } from "react";
import { cn } from "@/lib/cn";

/**
 * Texte d'un modèle, mis en forme.
 *
 * Les modèles écrivent en Markdown même quand on leur demande de ne pas le
 * faire : affiché tel quel, « **facture.txt** » garde ses astérisques. Ce
 * composant en rend le sous-ensemble courant (paragraphes, titres, listes,
 * citations, blocs de code, gras, italique, code en ligne) en éléments React.
 *
 * Aucun HTML n'est interprété : tout passe par des nœuds texte, un modèle ne
 * peut donc rien injecter dans la page. Les liens restent du texte : un lien
 * cliquable écrit par un modèle est une invitation à l'hameçonnage.
 *
 * Sauf `liens` (23/10/2026, nouveautés d'une version) : le texte vient alors
 * des notes de publication de l'éditeur, et `[texte](https://…)` devient un
 * lien, en https seulement, ouvert hors de l'application (`target="_blank"`,
 * que la fenêtre principale remet au navigateur du système, main.cjs). Tout
 * autre schéma (`javascript:`, `file:`, `data:`…) reste du texte.
 *
 * Sens d'écriture (30/09/2026) : chaque bloc porte `dir="auto"`. Une réponse en
 * arabe dans une interface française s'aligne à droite, une réponse en français
 * dans une interface arabe à gauche, paragraphe par paragraphe. Le code, lui,
 * reste de gauche à droite (`dir="ltr"`), quelle que soit la langue autour.
 */

type Bloc =
  | { type: "paragraphe"; lignes: string[] }
  | { type: "titre"; niveau: number; texte: string }
  | { type: "liste"; ordonnee: boolean; elements: string[] }
  | { type: "citation"; lignes: string[] }
  | { type: "code"; texte: string };

const PUCE = /^\s*[-*•]\s+(.*)$/;
const NUMERO = /^\s*\d+[.)]\s+(.*)$/;

function decouper(texte: string): Bloc[] {
  const blocs: Bloc[] = [];
  const lignes = texte.replace(/\r\n?/g, "\n").split("\n");
  for (let i = 0; i < lignes.length; i++) {
    const ligne = lignes[i] ?? "";
    if (/^\s*```/.test(ligne)) {
      const corps: string[] = [];
      for (i++; i < lignes.length && !/^\s*```/.test(lignes[i] ?? ""); i++) corps.push(lignes[i] ?? "");
      blocs.push({ type: "code", texte: corps.join("\n") });
      continue;
    }
    if (!ligne.trim()) continue;
    const titre = /^(#{1,4})\s+(.*)$/.exec(ligne);
    if (titre) {
      blocs.push({ type: "titre", niveau: titre[1]?.length ?? 1, texte: titre[2] ?? "" });
      continue;
    }
    if (/^\s*>/.test(ligne)) {
      const corps: string[] = [];
      for (; i < lignes.length && /^\s*>/.test(lignes[i] ?? ""); i++) corps.push((lignes[i] ?? "").replace(/^\s*>\s?/, ""));
      i--;
      blocs.push({ type: "citation", lignes: corps });
      continue;
    }
    if (PUCE.test(ligne) || NUMERO.test(ligne)) {
      const ordonnee = !PUCE.test(ligne);
      const motif = ordonnee ? NUMERO : PUCE;
      const elements: string[] = [];
      for (; i < lignes.length && motif.test(lignes[i] ?? ""); i++) elements.push(motif.exec(lignes[i] ?? "")?.[1] ?? "");
      i--;
      blocs.push({ type: "liste", ordonnee, elements });
      continue;
    }
    const corps: string[] = [];
    for (; i < lignes.length; i++) {
      const l = lignes[i] ?? "";
      if (!l.trim() || /^\s*```/.test(l) || /^#{1,4}\s/.test(l) || /^\s*>/.test(l) || PUCE.test(l) || NUMERO.test(l)) break;
      corps.push(l);
    }
    i--;
    blocs.push({ type: "paragraphe", lignes: corps });
  }
  return blocs;
}

/** Un lien `[texte](https://…)` ; l'adresse s'arrête au premier blanc, et admet un niveau de parenthèses (une page de Wikipédia). */
const LIEN = /\[([^\]\n]+)\]\((https:\/\/(?:[^()\s]|\([^()\s]*\))+)\)/g;

/** Gras, italique, code en ligne, et liens https quand `liens` est demandé. */
function enLigne(texte: string, liens = false): ReactNode[] {
  if (!liens) return formater(texte, 0);
  const morceaux: ReactNode[] = [];
  let dernier = 0;
  let n = 1;
  let m: RegExpExecArray | null;
  LIEN.lastIndex = 0;
  while ((m = LIEN.exec(texte))) {
    if (m.index > dernier) morceaux.push(...formater(texte.slice(dernier, m.index), n++ * 1000));
    let adresse: URL | null = null;
    try {
      adresse = new URL(m[2] ?? "");
    } catch {
      adresse = null;
    }
    morceaux.push(
      adresse && adresse.protocol === "https:" ? (
        <a
          key={`l${n++}`}
          href={adresse.href}
          target="_blank"
          rel="noreferrer noopener"
          className="text-foreground underline underline-offset-4 hover:no-underline"
        >
          {m[1]}
        </a>
      ) : (
        m[1]
      ),
    );
    dernier = m.index + m[0].length;
  }
  if (dernier < texte.length) morceaux.push(...formater(texte.slice(dernier), n * 1000));
  return morceaux;
}

function formater(texte: string, base: number): ReactNode[] {
  const morceaux: ReactNode[] = [];
  const motif = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(__[^_\n]+__)|(\*[^*\s][^*\n]*\*)/g;
  let dernier = 0;
  let m: RegExpExecArray | null;
  let n = base;
  while ((m = motif.exec(texte))) {
    if (m.index > dernier) morceaux.push(texte.slice(dernier, m.index));
    const brut = m[0];
    if (m[1]) morceaux.push(<code key={n++} dir="ltr" className="rounded bg-muted px-1 py-0.5 text-[0.9em]">{brut.slice(1, -1)}</code>);
    else if (m[2] || m[3]) morceaux.push(<strong key={n++} className="font-semibold text-foreground">{brut.slice(2, -2)}</strong>);
    else morceaux.push(<em key={n++}>{brut.slice(1, -1)}</em>);
    dernier = m.index + brut.length;
  }
  if (dernier < texte.length) morceaux.push(texte.slice(dernier));
  return morceaux;
}

export function TexteRiche({ texte, className, liens = false }: { texte: string; className?: string; liens?: boolean }) {
  return (
    <div className={cn("space-y-2 break-words", className)}>
      {decouper(texte).map((b, i) => {
        switch (b.type) {
          case "titre":
            return (
              <p key={i} dir="auto" className="font-semibold text-foreground">
                {enLigne(b.texte, liens)}
              </p>
            );
          case "liste": {
            const Liste = b.ordonnee ? "ol" : "ul";
            return (
              <Liste key={i} dir="auto" className={cn("space-y-0.5 ps-5", b.ordonnee ? "list-decimal" : "list-disc")}>
                {b.elements.map((e, j) => (
                  <li key={j}>{enLigne(e, liens)}</li>
                ))}
              </Liste>
            );
          }
          case "citation":
            return (
              <blockquote key={i} dir="auto" className="border-s-2 border-border ps-3 text-muted-foreground">
                {b.lignes.map((l, j) => (
                  <Fragment key={j}>
                    {j > 0 && <br />}
                    {enLigne(l, liens)}
                  </Fragment>
                ))}
              </blockquote>
            );
          case "code":
            return (
              <pre key={i} dir="ltr" className="overflow-x-auto rounded-lg bg-muted px-3 py-2 text-[0.85em] leading-relaxed">
                {b.texte}
              </pre>
            );
          default:
            return (
              <p key={i} dir="auto">
                {b.lignes.map((l, j) => (
                  <Fragment key={j}>
                    {j > 0 && <br />}
                    {enLigne(l, liens)}
                  </Fragment>
                ))}
              </p>
            );
        }
      })}
    </div>
  );
}

export default TexteRiche;
