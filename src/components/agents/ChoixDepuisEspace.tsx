import { useEffect, useState } from "react";
import { ChevronLeft, FileText, Folder, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { SegmentedTabs } from "@/components/ui/SegmentedTabs";
import { apiFetch } from "@/lib/endpoint";
import { ACCEPT_DOCUMENTS } from "@/lib/employes";
import { branding } from "@/config/branding";
import { listerBibliotheque, recupererDocument } from "@/lib/bibliotheque";
import { t, tf } from "@/lib/i18n";

/**
 * « Depuis OxoAI » : confier à un agent un document que l'instance a déjà,
 * sans passer par le Finder. Deux sources : la bibliothèque (ce que chacun
 * voit selon sa visibilité) et le dossier de travail de l'équipe (celui que
 * les agents voient déjà). Seuls les formats qu'un agent sait lire sont
 * proposés.
 */

interface Entree {
  nom: string;
  /** Chemin (dossier de l'équipe) ou identifiant (bibliothèque). */
  cle: string;
  dossier: boolean;
  taille?: number;
}

type Source = "bibliotheque" | "espace";

const EXTENSIONS = new Set(ACCEPT_DOCUMENTS.split(",").map((e) => e.replace(".", "").toLowerCase()));
const lisible = (nom: string) => EXTENSIONS.has((nom.split(".").pop() ?? "").toLowerCase());

async function listerEspace(chemin: string): Promise<Entree[]> {
  const r = await apiFetch(`/oxoai/espace?chemin=${encodeURIComponent(chemin)}`);
  const corps = (await r.json().catch(() => ({}))) as {
    entrees?: { nom: string; chemin: string; dossier: boolean; taille?: number }[];
    error?: { message?: string };
  };
  if (!r.ok) throw new Error(corps.error?.message ?? t("Dossier de travail illisible."));
  return (corps.entrees ?? []).map((e) => ({ nom: e.nom, cle: e.chemin, dossier: e.dossier, taille: e.taille }));
}

async function recupererEspace(e: Entree): Promise<File> {
  const r = await apiFetch(`/oxoai/espace/fichier?chemin=${encodeURIComponent(e.cle)}`);
  if (!r.ok) {
    const corps = (await r.json().catch(() => ({}))) as { error?: { message?: string } };
    throw new Error(corps.error?.message ?? `${e.nom} illisible.`);
  }
  return new File([await r.blob()], e.nom);
}

export function ChoixDepuisEspace({ onChoisis, onFermer }: { onChoisis: (f: File[]) => void; onFermer: () => void }) {
  const [source, setSource] = useState<Source>("bibliotheque");
  // Pile de dossiers ouverts : chemin (espace) ou identifiant (bibliothèque), avec leur nom.
  const [pile, setPile] = useState<{ cle: string; nom: string }[]>([]);
  const [entrees, setEntrees] = useState<Entree[] | null>(null);
  const [choisis, setChoisis] = useState<(Entree & { source: Source })[]>([]);
  const [occupe, setOccupe] = useState(false);
  const [erreur, setErreur] = useState<string | null>(null);
  const ici = pile.at(-1)?.cle ?? "";

  useEffect(() => {
    setEntrees(null);
    setErreur(null);
    const lecture =
      source === "espace"
        ? listerEspace(ici)
        : listerBibliotheque({ dossier: ici || null }).then((l) =>
            l.elements.map((e) => ({ nom: e.nom, cle: e.id, dossier: e.type === "dossier", taille: e.taille })),
          );
    void lecture.then(setEntrees).catch((err) => {
      setErreur(err instanceof Error ? err.message : String(err));
      setEntrees([]);
    });
  }, [source, ici]);

  const visibles = (entrees ?? []).filter((e) => e.dossier || lisible(e.nom));

  return (
    <Modal open onClose={occupe ? () => undefined : onFermer} size="md">
      <h2 className="text-lg font-semibold text-foreground">{tf("Depuis {0}", branding.name)}</h2>
      <SegmentedTabs
        className="mt-3"
        size="sm"
        options={[
          { id: "bibliotheque", label: t("Fichiers") },
          { id: "espace", label: t("Dossier de l'équipe") },
        ]}
        value={source}
        onChange={(id) => {
          setSource(id as Source);
          setPile([]);
        }}
      />
      <div className="mt-3 flex min-h-[1.5rem] items-center gap-2 text-sm text-muted-foreground">
        {pile.length > 0 && (
          <button
            type="button"
            onClick={() => setPile(pile.slice(0, -1))}
            className="inline-flex items-center gap-1 hover:text-foreground"
          >
            <ChevronLeft size={15} strokeWidth={1.75} />{" "}{t("Retour")}
          </button>
        )}
        <span className="truncate">
          {source === "bibliotheque" ? t("Fichiers") : t("Dossier de l'équipe")}
          {pile.map((p) => ` / ${p.nom}`).join("")}
        </span>
      </div>
      <ul className="mt-2 max-h-72 space-y-0.5 overflow-y-auto rounded-xl border border-border p-1.5">
        {entrees === null && (
          <li className="flex justify-center py-6 text-muted-foreground">
            <Loader2 size={16} className="animate-spin" />
          </li>
        )}
        {entrees !== null && visibles.length === 0 && (
          <li className="py-6 text-center text-sm text-muted-foreground">{t("Aucun document lisible ici.")}</li>
        )}
        {visibles.map((e) => {
          const coche = choisis.some((c) => c.source === source && c.cle === e.cle);
          return (
            <li key={e.cle}>
              <button
                type="button"
                onClick={() =>
                  e.dossier
                    ? setPile([...pile, { cle: e.cle, nom: e.nom }])
                    : setChoisis((l) =>
                        coche ? l.filter((c) => !(c.source === source && c.cle === e.cle)) : [...l, { ...e, source }],
                      )
                }
                className={`flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-start text-sm hover:bg-muted ${coche ? "bg-muted" : ""}`}
              >
                {e.dossier ? (
                  <Folder size={15} strokeWidth={1.75} className="shrink-0 text-muted-foreground" />
                ) : (
                  <input type="checkbox" readOnly checked={coche} tabIndex={-1} className="accent-current" />
                )}
                {!e.dossier && <FileText size={15} strokeWidth={1.75} className="shrink-0 text-muted-foreground" />}
                <span className="min-w-0 flex-1 truncate text-foreground">{e.nom}</span>
                {e.taille !== undefined && (
                  <span className="shrink-0 text-xs text-muted-foreground">{Math.max(1, Math.round(e.taille / 1024))}{" "}{t("Ko")}</span>
                )}
              </button>
            </li>
          );
        })}
      </ul>
      {erreur && <p className="mt-2 text-xs text-destructive">{erreur}</p>}
      <div className="mt-4 flex items-center justify-end gap-2">
        {choisis.length > 0 && (
          <span className="me-auto text-xs text-muted-foreground">
            {choisis.length === 1 ? t("1 document choisi") : tf("{0} documents choisis", choisis.length)}
          </span>
        )}
        <Button variant="ghost" disabled={occupe} onClick={onFermer}>
          {t("Annuler")}
        </Button>
        <Button
          disabled={occupe || choisis.length === 0}
          onClick={() => {
            setOccupe(true);
            setErreur(null);
            void Promise.all(choisis.map((c) => (c.source === "espace" ? recupererEspace(c) : recupererDocument({ id: c.cle, nom: c.nom }))))
              .then((f) => {
                onChoisis(f);
                onFermer();
              })
              .catch((err) => {
                setErreur(err instanceof Error ? err.message : String(err));
                setOccupe(false);
              });
          }}
        >
          {occupe ? t("Récupération…") : choisis.length > 1 ? tf("Ajouter {0} documents", choisis.length) : t("Ajouter")}
        </Button>
      </div>
    </Modal>
  );
}

export default ChoixDepuisEspace;
