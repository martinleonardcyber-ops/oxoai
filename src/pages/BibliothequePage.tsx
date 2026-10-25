import { useCallback, useEffect, useRef, useState, type DragEvent } from "react";
import { useSearchParams } from "react-router-dom";
import {
  BookOpenText,
  ChevronLeft,
  ChevronRight,
  Download,
  FileText,
  Folder,
  FolderInput,
  FolderPlus,
  Globe,
  Home,
  FolderOpen,
  Loader2,
  Lock,
  MoreHorizontal,
  Pencil,
  RotateCw,
  Star,
  Trash2,
  Upload,
  Users,
} from "lucide-react";
import { Button } from "@/components/ui/Button";
import { IconButton } from "@/components/ui/IconButton";
import { EmptyState } from "@/components/ui/EmptyState";
import { Modal } from "@/components/ui/Modal";
import { Popover } from "@/components/ui/Popover";
import { Field, Input } from "@/components/ui/Field";
import { InfoBox } from "@/components/ui/InfoBox";
import { SearchInput } from "@/components/ui/SearchInput";
import { cn } from "@/lib/cn";
import { formaterDate } from "@/lib/formats";
import { useGroupes, type Groupe } from "@/lib/groupes";
import { allAccounts } from "@/lib/store/accounts";
import {
  creerDossier,
  importerDocument,
  listerBibliotheque,
  marquerFavori,
  modifierElement,
  supprimerElement,
  taillePlaisante,
  TAILLE_MAX,
  LIBELLE_DOCUMENT_MAX,
  EXTRACTION_MAX,
  telechargerDocument,
  type Couleur,
  type ElementBibliotheque,
  type Listage,
  type Visibilite,
} from "@/lib/bibliotheque";
import { BasesConnaissances } from "@/components/bibliotheque/BasesConnaissances";
import { t, tf, lister } from "@/lib/i18n";

/**
 * Bibliothèque de l'équipe : dossiers et documents gardés par l'instance,
 * chiffrés, chacun avec sa visibilité (vous seul, des groupes, toute
 * l'équipe). Les agents y cherchent et y lisent ce qu'on leur a partagé ;
 * « Depuis OxoAI » y puise pour leur confier un document.
 */

type Vue = "tous" | "favoris" | "prives" | "groupes" | "connaissances";

const FILTRES: { id: Vue; label: string; icon: typeof Folder }[] = [
  { id: "tous", label: t("Tous les fichiers"), icon: Folder },
  { id: "favoris", label: t("Favoris"), icon: Star },
  { id: "prives", label: t("Privés"), icon: Lock },
  { id: "groupes", label: t("Groupes"), icon: Users },
  // Les bases de connaissances rassemblent des documents d'ici : elles vivent à côté d'eux.
  { id: "connaissances", label: t("Bases de connaissances"), icon: BookOpenText },
];

const EMOJIS = ["📁", "🎯", "💼", "📊", "🧪", "🔬", "📚", "💰"];

const COULEURS: { valeur: Couleur | ""; nom: string; classe: string }[] = [
  { valeur: "", nom: t("Aucune"), classe: "text-muted-foreground" },
  { valeur: "vert", nom: "Vert", classe: "text-accent" },
  { valeur: "bleu", nom: "Bleu", classe: "text-info" },
  { valeur: "orange", nom: "Orange", classe: "text-warning" },
  { valeur: "rouge", nom: "Rouge", classe: "text-destructive" },
];
const classeCouleur = (c?: Couleur) => COULEURS.find((x) => x.valeur === (c ?? ""))?.classe ?? "text-muted-foreground";

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

export function BibliothequePage() {
  // « ?vue=connaissances » : le lien « Gérer les bases » de la zone de saisie ouvre directement les bases.
  const [params] = useSearchParams();
  const [vue, setVue] = useState<Vue>(params.get("vue") === "connaissances" ? "connaissances" : "tous");
  const [dossier, setDossier] = useState<string | null>(null);
  const [recherche, setRecherche] = useState("");
  const [terme, setTerme] = useState("");
  const [listage, setListage] = useState<Listage | null>(null);
  const [erreur, setErreur] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [nouveauDossier, setNouveauDossier] = useState(false);
  const [aImporter, setAImporter] = useState<File[] | null>(null);
  const [edition, setEdition] = useState<{ element: ElementBibliotheque; mode: "renommer" | "visibilite" | "deplacer" } | null>(null);
  const [aSupprimer, setASupprimer] = useState<ElementBibliotheque | null>(null);
  const [depot, setDepot] = useState(false);
  const choix = useRef<HTMLInputElement>(null);
  const { etat: groupes } = useGroupes();
  const mesGroupes = (groupes?.groupes ?? []).filter((g) => g.estMembre);

  // La recherche part après une courte pause de frappe, pas à chaque touche.
  useEffect(() => {
    const t = setTimeout(() => setTerme(recherche), 300);
    return () => clearTimeout(t);
  }, [recherche]);

  const charger = useCallback(async () => {
    // Les bases ont leur propre liste (BasesConnaissances) : rien à lire ici.
    if (vue === "connaissances" && !terme) return;
    try {
      setListage(await listerBibliotheque({ vue, dossier: vue === "tous" ? dossier : null, q: terme }));
      setErreur(null);
    } catch (err) {
      setErreur(message(err));
      // Le dossier ouvert a disparu (supprimé, visibilité retirée) : retour à la racine.
      if (dossier) setDossier(null);
    }
  }, [vue, dossier, terme]);

  useEffect(() => {
    setListage(null);
    void charger();
  }, [charger]);

  // Un message d'import ne suit pas la personne d'un dossier à l'autre.
  useEffect(() => setInfo(null), [vue, dossier, terme]);

  const ouvrirDossier = (id: string | null) => {
    setVue("tous");
    setRecherche("");
    setTerme("");
    setDossier(id);
  };

  const courant = listage?.dossier ?? null;
  const elements = listage?.elements ?? [];

  const deposer = (e: DragEvent) => {
    e.preventDefault();
    setDepot(false);
    const fichiers = [...e.dataTransfer.files];
    if (fichiers.length > 0) setAImporter(fichiers);
  };

  return (
    <div
      className="relative flex h-full flex-col overflow-y-auto px-8 py-7"
      onDragOver={(e) => {
        if ([...e.dataTransfer.types].includes("Files")) {
          e.preventDefault();
          setDepot(true);
        }
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setDepot(false);
      }}
      onDrop={deposer}
    >
      {/* En-tête */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span className="flex items-center gap-2.5">
          <FolderOpen size={28} strokeWidth={1.75} className="text-foreground" />
          <h1 className="text-3xl font-semibold tracking-tight text-foreground">{t("Fichiers")}</h1>
        </span>
        <div className="flex items-center gap-2">
          <Button variant="secondary" icon={FolderPlus} onClick={() => setNouveauDossier(true)}>
            {t("Nouveau dossier")}
          </Button>
          <Button icon={Upload} onClick={() => choix.current?.click()}>
            {t("Importer")}
          </Button>
          <input
            ref={choix}
            type="file"
            multiple
            className="hidden"
            onChange={(e) => {
              const fichiers = [...(e.target.files ?? [])];
              e.target.value = "";
              if (fichiers.length > 0) setAImporter(fichiers);
            }}
          />
          <IconButton icon={RotateCw} label={t("Actualiser")} onClick={() => void charger()} />
        </div>
      </div>

      {/* Filtres et recherche */}
      <div className="mt-5 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-1">
          <IconButton icon={Home} label={t("Accueil de la bibliothèque")} onClick={() => ouvrirDossier(null)} />
          {FILTRES.map((f) => {
            const Icon = f.icon;
            const actif = f.id === vue && !terme;
            return (
              <button
                key={f.id}
                type="button"
                onClick={() => {
                  setRecherche("");
                  setTerme("");
                  setDossier(null);
                  setVue(f.id);
                }}
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-sm transition-colors",
                  actif
                    ? "border border-border bg-card font-medium text-foreground shadow-sm"
                    : "text-muted-foreground hover:bg-muted hover:text-foreground",
                )}
              >
                <Icon size={15} strokeWidth={1.75} />
                {f.label}
              </button>
            );
          })}
        </div>
        <SearchInput
          containerClassName="w-[260px]"
          placeholder={t("Rechercher (nom ou contenu)")}
          aria-label={t("Rechercher dans la bibliothèque")}
          value={recherche}
          onChange={(e) => setRecherche(e.target.value)}
        />
      </div>

      {/* Fil d'Ariane */}
      {vue === "tous" && !terme && courant && (
        <nav className="mt-4 flex flex-wrap items-center gap-1 text-sm text-muted-foreground" aria-label={t("Emplacement")}>
          <button type="button" onClick={() => ouvrirDossier(null)} className="hover:text-foreground">
            {t("Fichiers")}
          </button>
          {listage?.chemin.map((c, i) => (
            <span key={c.id} className="flex items-center gap-1">
              <ChevronRight size={14} strokeWidth={1.75} />
              {i === (listage?.chemin.length ?? 0) - 1 ? (
                <span className="font-medium text-foreground">{c.nom}</span>
              ) : (
                <button type="button" onClick={() => ouvrirDossier(c.id)} className="hover:text-foreground">
                  {c.nom}
                </button>
              )}
            </span>
          ))}
        </nav>
      )}
      {terme && (
        <p className="mt-4 text-sm text-muted-foreground">
          {listage
            ? elements.length === 1
              ? tf("1 résultat pour « {0} »", terme)
              : tf("{0} résultats pour « {1} »", elements.length, terme)
            : t("Recherche…")}
        </p>
      )}

      {erreur && (
        <InfoBox tone="warning" className="mt-4">
          {erreur}
        </InfoBox>
      )}
      {info && (
        <InfoBox tone="muted" className="mt-4">
          {info}
        </InfoBox>
      )}

      {vue === "connaissances" && !terme ? (
        <BasesConnaissances mesGroupes={mesGroupes} groupes={groupes?.groupes ?? []} />
      ) : !listage && !erreur ? (
        <div className="flex flex-1 items-center justify-center text-muted-foreground">
          <Loader2 size={20} className="animate-spin" />
        </div>
      ) : elements.length === 0 ? (
        <EmptyState
          icon={terme ? FileText : Folder}
          title={
            terme
              ? t("Aucun résultat")
              : vue === "favoris"
                ? t("Aucun favori")
                : vue === "groupes"
                  ? t("Rien n'est partagé avec vos groupes")
                  : vue === "prives"
                    ? t("Aucun document privé")
                    : t("Aucun élément dans ce dossier")
          }
          description={
            terme
              ? t("Rien ne correspond, ni dans les noms ni dans le texte des documents.")
              : vue === "favoris"
                ? t("Marquez un dossier ou un document d'une étoile pour le retrouver ici.")
                : tf("Glissez des fichiers ici, ou importez-les. Un document de {0} au plus, PDF, Word, Excel, PowerPoint, texte ou image.", LIBELLE_DOCUMENT_MAX)
          }
        />
      ) : (
        /*
         * La marge du bas, reprise aussitôt (`pb-56 -mb-56`) : une zone qui
         * défile en largeur coupe aussi en hauteur, et le menu « … » d'une des
         * dernières lignes s'ouvrait à moitié, à faire défiler dans le tableau
         * (vu à l'écran le 30/09/2026, trois fichiers : « Déplacer » et
         * « Supprimer » hors de vue). Le menu a maintenant la place de s'ouvrir.
         */
        <div className="-mb-56 mt-4 overflow-x-auto pb-56">
          <table className="w-full min-w-[640px] text-sm">
            <thead>
              <tr className="border-b border-border text-start text-xs text-muted-foreground">
                <th className="py-2 ps-2 font-medium">{t("Nom")}</th>
                <th className="py-2 font-medium">{t("Visibilité")}</th>
                <th className="py-2 font-medium">{t("Propriétaire")}</th>
                <th className="py-2 text-end font-medium">{t("Taille")}</th>
                <th className="py-2 pe-2 text-end font-medium">{t("Modifié")}</th>
                <th className="w-10" />
              </tr>
            </thead>
            <tbody>
              {elements.map((e) => (
                <Ligne
                  key={e.id}
                  element={e}
                  groupes={groupes?.groupes ?? []}
                  onOuvrir={() => {
                    if (e.type === "dossier") ouvrirDossier(e.id);
                    else void telechargerDocument(e).catch((err) => setErreur(message(err)));
                  }}
                  onFavori={() =>
                    void marquerFavori(e.id, !e.favori)
                      .then(charger)
                      .catch((err) => setErreur(message(err)))
                  }
                  onAction={(mode) => {
                    setInfo(null);
                    if (mode === "supprimer") setASupprimer(e);
                    else if (mode === "telecharger") void telechargerDocument(e).catch((err) => setErreur(message(err)));
                    else setEdition({ element: e, mode });
                  }}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {depot && (
        <div className="pointer-events-none absolute inset-3 flex items-center justify-center rounded-2xl border-2 border-dashed border-ring bg-background/80 text-sm font-medium text-foreground">
          {t("Déposez vos fichiers pour les importer")}{courant ? tf(" dans « {0} »", courant.nom) : ""}
        </div>
      )}

      {nouveauDossier && (
        <DossierModal
          mesGroupes={mesGroupes}
          parent={courant}
          onFermer={() => setNouveauDossier(false)}
          onFait={async () => {
            setNouveauDossier(false);
            await charger();
          }}
        />
      )}
      {aImporter && (
        <ImportModal
          fichiers={aImporter}
          mesGroupes={mesGroupes}
          parent={courant}
          onFermer={() => setAImporter(null)}
          onFait={async (n) => {
            setAImporter(null);
            setInfo(n > 1 ? tf("{0} documents importés.", n) : tf("{0} document importé.", n));
            await charger();
          }}
        />
      )}
      {edition && (
        <EditionModal
          {...edition}
          mesGroupes={mesGroupes}
          onFermer={() => setEdition(null)}
          onFait={async () => {
            setEdition(null);
            await charger();
          }}
        />
      )}
      {aSupprimer && (
        <Modal open onClose={() => setASupprimer(null)} size="sm">
          <SuppressionModal
            element={aSupprimer}
            onFermer={() => setASupprimer(null)}
            onFait={async () => {
              setASupprimer(null);
              await charger();
            }}
          />
        </Modal>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */

function PastilleVisibilite({ element, groupes }: { element: ElementBibliotheque; groupes: Groupe[] }) {
  if (element.visibilite === "organisation") {
    return (
      <span className="inline-flex items-center gap-1 text-muted-foreground">
        <Globe size={13} strokeWidth={1.75} />{" "}{t("Toute l'équipe")}
      </span>
    );
  }
  if (element.visibilite === "groupes") {
    const noms = element.groupes.map((id) => groupes.find((g) => g.id === id)?.nom ?? t("Groupe supprimé"));
    return (
      <span className="inline-flex max-w-[220px] items-center gap-1 truncate text-muted-foreground" title={lister(noms)}>
        <Users size={13} strokeWidth={1.75} className="shrink-0" /> <span className="truncate">{lister(noms)}</span>
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 text-muted-foreground">
      <Lock size={13} strokeWidth={1.75} />{" "}{t("Vous seul")}
    </span>
  );
}

type Action = "renommer" | "visibilite" | "deplacer" | "supprimer" | "telecharger";

function Ligne({
  element: e,
  groupes,
  onOuvrir,
  onFavori,
  onAction,
}: {
  element: ElementBibliotheque;
  groupes: Groupe[];
  onOuvrir: () => void;
  onFavori: () => void;
  onAction: (a: Action) => void;
}) {
  const [menu, setMenu] = useState(false);
  const proprietaire = e.estProprietaire ? t("Vous") : (allAccounts().find((a) => a.id === e.ownerId)?.fullName ?? t("Un ancien membre"));
  const actions: { id: Action; label: string; icon: typeof Pencil; danger?: boolean }[] = [
    ...(e.type === "document" ? [{ id: "telecharger" as const, label: t("Télécharger"), icon: Download }] : []),
    ...(e.estProprietaire
      ? [
          { id: "renommer" as const, label: e.type === "dossier" ? t("Renommer, emoji et couleur") : t("Renommer"), icon: Pencil },
          { id: "visibilite" as const, label: t("Qui peut le voir"), icon: Users },
          { id: "deplacer" as const, label: t("Déplacer"), icon: FolderInput },
          { id: "supprimer" as const, label: t("Supprimer"), icon: Trash2, danger: true },
        ]
      : []),
  ];
  return (
    <tr className="group border-b border-border/60 hover:bg-muted/40">
      <td className="py-2 ps-2">
        <div className="flex items-center gap-2.5">
          <button
            type="button"
            aria-label={e.favori ? tf("Retirer {0} des favoris", e.nom) : tf("Mettre {0} en favori", e.nom)}
            onClick={onFavori}
            className={cn(
              "rounded p-0.5 transition-colors",
              e.favori ? "text-warning" : "text-muted-foreground/40 opacity-0 hover:text-warning group-hover:opacity-100 focus-visible:opacity-100",
            )}
          >
            <Star size={15} strokeWidth={1.75} fill={e.favori ? "currentColor" : "none"} />
          </button>
          <button type="button" onClick={onOuvrir} className="flex min-w-0 items-center gap-2 text-start">
            {e.type === "dossier" ? (
              e.emoji ? (
                <span className="w-[18px] text-center text-base leading-none">{e.emoji}</span>
              ) : (
                <Folder size={18} strokeWidth={1.75} className={cn("shrink-0", classeCouleur(e.couleur))} fill="currentColor" fillOpacity={0.15} />
              )
            ) : (
              <FileText size={18} strokeWidth={1.75} className="shrink-0 text-muted-foreground" />
            )}
            <span className="truncate font-medium text-foreground hover:underline">{e.nom}</span>
            {e.type === "dossier" && e.emoji && e.couleur && (
              <span className={cn("h-2 w-2 shrink-0 rounded-full bg-current", classeCouleur(e.couleur))} />
            )}
          </button>
        </div>
      </td>
      <td className="py-2">
        <PastilleVisibilite element={e} groupes={groupes} />
      </td>
      <td className="py-2 text-muted-foreground">{proprietaire}</td>
      <td className="py-2 text-end tabular-nums text-muted-foreground">{e.type === "document" ? taillePlaisante(e.taille) : ""}</td>
      <td className="py-2 pe-2 text-end tabular-nums text-muted-foreground">{formaterDate(e.updatedAt)}</td>
      <td className="py-1 pe-1 text-end">
        {actions.length > 0 && (
          <Popover
            align="end"
            width={230}
            open={menu}
            onOpenChange={setMenu}
            panelClassName="p-1"
            trigger={(p) => (
              <button
                type="button"
                {...p}
                aria-label={tf("Actions pour {0}", e.nom)}
                className="rounded-lg p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                <MoreHorizontal size={16} strokeWidth={1.75} />
              </button>
            )}
          >
            {actions.map((a) => (
              <button
                key={a.id}
                type="button"
                onClick={() => {
                  setMenu(false);
                  onAction(a.id);
                }}
                className={cn(
                  "flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-start text-sm hover:bg-muted",
                  a.danger ? "text-destructive" : "text-foreground",
                )}
              >
                <a.icon size={15} strokeWidth={1.75} />
                {a.label}
              </button>
            ))}
          </Popover>
        )}
      </td>
    </tr>
  );
}

/* ------------------------------------------------------------------ */

/** Qui voit l'élément : vous seul, des groupes (les vôtres), ou toute l'équipe. */
export function ChoixVisibilite({
  visibilite,
  groupes,
  onChange,
  mesGroupes,
}: {
  visibilite: Visibilite;
  groupes: string[];
  onChange: (v: Visibilite, g: string[]) => void;
  mesGroupes: Groupe[];
}) {
  const options: { id: Visibilite; label: string; aide: string; icon: typeof Lock }[] = [
    { id: "prive", label: t("Vous seul"), aide: t("Personne d'autre."), icon: Lock },
    { id: "groupes", label: t("Des groupes"), aide: t("Les membres des groupes choisis."), icon: Users },
    { id: "organisation", label: t("Toute l'équipe"), aide: t("Chaque compte de l'instance."), icon: Globe },
  ];
  return (
    <div className="space-y-2">
      <div className="grid gap-2 sm:grid-cols-3">
        {options.map((o) => (
          <button
            key={o.id}
            type="button"
            disabled={o.id === "groupes" && mesGroupes.length === 0}
            title={o.id === "groupes" && mesGroupes.length === 0 ? t("Vous n'êtes membre d'aucun groupe : créez-en un dans Groupes.") : undefined}
            onClick={() => onChange(o.id, o.id === "groupes" ? groupes : [])}
            className={cn(
              "flex flex-col items-start gap-0.5 rounded-xl border px-3 py-2.5 text-start transition-colors disabled:cursor-not-allowed disabled:opacity-50",
              visibilite === o.id ? "border-ring bg-muted" : "border-border hover:bg-muted/60",
            )}
          >
            <span className="flex items-center gap-1.5 text-sm font-medium text-foreground">
              <o.icon size={14} strokeWidth={1.75} /> {o.label}
            </span>
            <span className="text-xs text-muted-foreground">{o.aide}</span>
          </button>
        ))}
      </div>
      {visibilite === "groupes" && (
        <div className="flex flex-wrap gap-1.5">
          {mesGroupes.map((g) => {
            const coche = groupes.includes(g.id);
            return (
              <button
                key={g.id}
                type="button"
                onClick={() => onChange("groupes", coche ? groupes.filter((x) => x !== g.id) : [...groupes, g.id])}
                className={cn(
                  "rounded-full border px-3 py-1 text-xs transition-colors",
                  coche ? "border-primary bg-primary text-primary-foreground" : "border-border text-foreground hover:bg-muted",
                )}
              >
                {g.nom}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function DossierModal({
  mesGroupes,
  parent,
  onFermer,
  onFait,
}: {
  mesGroupes: Groupe[];
  parent: Listage["dossier"];
  onFermer: () => void;
  onFait: () => Promise<void>;
}) {
  const [nom, setNom] = useState("");
  const [vis, setVis] = useState<{ v: Visibilite; g: string[] }>({ v: "prive", g: [] });
  const [emoji, setEmoji] = useState<string | undefined>();
  const [couleur, setCouleur] = useState<Couleur | "">("");
  const [occupe, setOccupe] = useState(false);
  const [erreur, setErreur] = useState<string | null>(null);
  return (
    <Modal open onClose={onFermer} size="md">
      <h2 className="flex items-center gap-2 text-lg font-semibold text-foreground">
        <FolderPlus size={19} strokeWidth={1.75} />{" "}{t("Nouveau dossier")}
      </h2>
      <p className="mt-1 text-sm text-muted-foreground">
        {parent ? tf("Dans « {0} ».", parent.nom) : t("À la racine de la bibliothèque.")}
      </p>
      <form
        className="mt-5 space-y-4"
        onSubmit={(ev) => {
          ev.preventDefault();
          if (!nom.trim() || occupe) return;
          setOccupe(true);
          setErreur(null);
          void creerDossier({ nom, parentId: parent?.id ?? null, visibilite: vis.v, groupes: vis.g, emoji, ...(couleur ? { couleur } : {}) })
            .then(onFait)
            .catch((err) => {
              setErreur(message(err));
              setOccupe(false);
            });
        }}
      >
        <Field label={t("Nom du dossier")} required>
          <Input placeholder={t("Mon dossier")} value={nom} maxLength={120} autoFocus onChange={(e) => setNom(e.target.value)} />
        </Field>
        <div className="space-y-1.5">
          <p className="text-sm font-medium text-foreground">{t("Qui peut le voir")}</p>
          <ChoixVisibilite visibilite={vis.v} groupes={vis.g} mesGroupes={mesGroupes} onChange={(v, g) => setVis({ v, g })} />
          <p className="text-xs text-muted-foreground">{t("Ce qu'on y dépose prend cette visibilité par défaut.")}</p>
        </div>
        <ApparenceDossier emoji={emoji} couleur={couleur} onEmoji={setEmoji} onCouleur={setCouleur} />
        {erreur && <InfoBox tone="warning">{erreur}</InfoBox>}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onFermer}>
            {t("Annuler")}
          </Button>
          <Button type="submit" disabled={!nom.trim() || occupe || (vis.v === "groupes" && vis.g.length === 0)}>
            {occupe ? t("Création…") : t("Créer")}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function ApparenceDossier({
  emoji,
  couleur,
  onEmoji,
  onCouleur,
}: {
  emoji?: string;
  couleur: Couleur | "";
  onEmoji: (e: string | undefined) => void;
  onCouleur: (c: Couleur | "") => void;
}) {
  return (
    <>
      <div className="space-y-1.5">
        <p className="text-sm font-medium text-foreground">{t("Emoji (facultatif)")}</p>
        <div className="flex flex-wrap gap-2">
          {EMOJIS.map((e) => (
            <button
              key={e}
              type="button"
              aria-pressed={emoji === e}
              onClick={() => onEmoji(emoji === e ? undefined : e)}
              className={cn(
                "flex h-10 w-10 items-center justify-center rounded-lg border text-lg transition-colors",
                emoji === e ? "border-ring bg-muted" : "border-border hover:bg-muted",
              )}
            >
              {e}
            </button>
          ))}
        </div>
      </div>
      <div className="space-y-1.5">
        <p className="text-sm font-medium text-foreground">{t("Couleur (facultatif)")}</p>
        <div className="flex flex-wrap gap-2">
          {COULEURS.map((c) => (
            <button
              key={c.valeur || "aucune"}
              type="button"
              aria-pressed={couleur === c.valeur}
              onClick={() => onCouleur(c.valeur)}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs transition-colors",
                couleur === c.valeur ? "border-ring bg-muted text-foreground" : "border-border text-muted-foreground hover:bg-muted",
              )}
            >
              <Folder size={13} strokeWidth={1.75} className={c.classe} fill="currentColor" fillOpacity={0.2} />
              {c.nom}
            </button>
          ))}
        </div>
      </div>
    </>
  );
}

function ImportModal({
  fichiers,
  mesGroupes,
  parent,
  onFermer,
  onFait,
}: {
  fichiers: File[];
  mesGroupes: Groupe[];
  parent: Listage["dossier"];
  onFermer: () => void;
  onFait: (n: number) => Promise<void>;
}) {
  // Par défaut, la visibilité du dossier où l'on dépose : c'est ce qu'on attend d'un dossier partagé.
  const [vis, setVis] = useState<{ v: Visibilite; g: string[] }>({ v: parent?.visibilite === "organisation" ? "organisation" : "prive", g: [] });
  const [avancement, setAvancement] = useState<number | null>(null);
  /** Part du fichier en cours déjà envoyée, de 0 à 1. */
  const [envoye, setEnvoye] = useState(0);
  const [erreurs, setErreurs] = useState<string[]>([]);
  const trop = fichiers.filter((f) => f.size > TAILLE_MAX);
  const sansTexte = fichiers.some((f) => f.size > EXTRACTION_MAX && f.size <= TAILLE_MAX);

  const lancer = async () => {
    setErreurs([]);
    let faits = 0;
    const echecs: string[] = [];
    for (const [i, f] of fichiers.entries()) {
      if (f.size > TAILLE_MAX) continue;
      setAvancement(i);
      setEnvoye(0);
      try {
        await importerDocument(f, { parentId: parent?.id ?? null, visibilite: vis.v, groupes: vis.g }, setEnvoye);
        faits += 1;
      } catch (err) {
        echecs.push(message(err));
      }
    }
    setAvancement(null);
    if (echecs.length > 0) setErreurs(echecs);
    else await onFait(faits);
  };

  return (
    <Modal open onClose={avancement !== null ? () => undefined : onFermer} size="md">
      <h2 className="flex items-center gap-2 text-lg font-semibold text-foreground">
        <Upload size={19} strokeWidth={1.75} />{" "}{t("Importer")}{" "}{fichiers.length > 1 ? `${fichiers.length} documents` : "un document"}
      </h2>
      <p className="mt-1 text-sm text-muted-foreground">
        {parent ? tf("Dans « {0} ».", parent.nom) : t("À la racine de la bibliothèque.")}{" "}{t("Chiffrés sur l'instance ; leur texte est extrait sur ce poste pour la recherche et les agents.")}
      </p>
      <ul className="mt-4 max-h-40 space-y-1 overflow-y-auto rounded-xl border border-border p-2 text-sm">
        {fichiers.map((f, i) => (
          <li key={`${f.name}-${i}`} className="flex items-center gap-2">
            {avancement === i ? (
              <Loader2 size={14} className="shrink-0 animate-spin text-muted-foreground" />
            ) : (
              <FileText size={14} strokeWidth={1.75} className="shrink-0 text-muted-foreground" />
            )}
            <span className="min-w-0 flex-1 truncate text-foreground">{f.name}</span>
            <span className={cn("shrink-0 text-xs tabular-nums", f.size > TAILLE_MAX ? "text-destructive" : "text-muted-foreground")}>
              {avancement === i ? `${Math.round(envoye * 100)} %` : taillePlaisante(f.size)}
            </span>
          </li>
        ))}
      </ul>
      <div className="mt-4 space-y-1.5">
        <p className="text-sm font-medium text-foreground">{t("Qui peut les voir")}</p>
        <ChoixVisibilite visibilite={vis.v} groupes={vis.g} mesGroupes={mesGroupes} onChange={(v, g) => setVis({ v, g })} />
      </div>
      {trop.length > 0 && (
        <InfoBox tone="warning" className="mt-3">
          {trop.length > 1 ? tf("{0} fichiers dépassent", trop.length) : tf("« {0} » dépasse", trop[0]!.name)} {LIBELLE_DOCUMENT_MAX} :{" "}
          {trop.length > 1 ? t("ils ne seront pas importés.") : t("il ne sera pas importé.")}
        </InfoBox>
      )}
      {sansTexte && (
        <InfoBox tone="muted" className="mt-3">
          {t("Au-delà de 100 Mo, le texte d'un document n'est pas extrait sur ce poste : il est gardé, mais la recherche et les agents ne verront que son nom.")}
        </InfoBox>
      )}
      {erreurs.length > 0 && (
        <InfoBox tone="warning" className="mt-3">
          {erreurs.join(" ")}
        </InfoBox>
      )}
      <div className="mt-5 flex justify-end gap-2">
        <Button variant="secondary" disabled={avancement !== null} onClick={onFermer}>
          {erreurs.length > 0 ? t("Fermer") : t("Annuler")}
        </Button>
        <Button
          disabled={avancement !== null || (vis.v === "groupes" && vis.g.length === 0) || trop.length === fichiers.length}
          onClick={() => void lancer()}
        >
          {avancement !== null ? tf("Import {0} sur {1}…", avancement + 1, fichiers.length) : t("Importer")}
        </Button>
      </div>
    </Modal>
  );
}

function EditionModal({
  element,
  mode,
  mesGroupes,
  onFermer,
  onFait,
}: {
  element: ElementBibliotheque;
  mode: "renommer" | "visibilite" | "deplacer";
  mesGroupes: Groupe[];
  onFermer: () => void;
  onFait: () => Promise<void>;
}) {
  const [nom, setNom] = useState(element.nom);
  const [emoji, setEmoji] = useState<string | undefined>(element.emoji);
  const [couleur, setCouleur] = useState<Couleur | "">(element.couleur ?? "");
  const [vis, setVis] = useState<{ v: Visibilite; g: string[] }>({
    v: element.visibilite,
    g: element.groupes.filter((g) => mesGroupes.some((m) => m.id === g)),
  });
  const [destination, setDestination] = useState<{ id: string | null; nom: string } | null>(null);
  const [occupe, setOccupe] = useState(false);
  const [erreur, setErreur] = useState<string | null>(null);

  const enregistrer = () => {
    setOccupe(true);
    setErreur(null);
    const changements =
      mode === "renommer"
        ? { nom, ...(element.type === "dossier" ? { emoji: emoji ?? "", couleur } : {}) }
        : mode === "visibilite"
          ? { visibilite: vis.v, groupes: vis.g }
          : { parentId: destination?.id ?? null };
    void modifierElement(element.id, changements)
      .then(onFait)
      .catch((err) => {
        setErreur(message(err));
        setOccupe(false);
      });
  };

  const titre = mode === "renommer" ? t("Renommer") : mode === "visibilite" ? t("Qui peut le voir") : t("Déplacer");
  const pret =
    !occupe &&
    (mode === "renommer" ? Boolean(nom.trim()) : mode === "visibilite" ? !(vis.v === "groupes" && vis.g.length === 0) : destination !== null);

  return (
    <Modal open onClose={onFermer} size="md">
      <h2 className="pe-8 text-lg font-semibold text-foreground">{titre}</h2>
      <p className="mt-1 truncate text-sm text-muted-foreground">{element.nom}</p>
      <div className="mt-5 space-y-4">
        {mode === "renommer" && (
          <>
            <Field label={t("Nom")} required>
              <Input value={nom} maxLength={120} autoFocus onChange={(e) => setNom(e.target.value)} />
            </Field>
            {element.type === "dossier" && <ApparenceDossier emoji={emoji} couleur={couleur} onEmoji={setEmoji} onCouleur={setCouleur} />}
          </>
        )}
        {mode === "visibilite" && (
          <>
            <ChoixVisibilite visibilite={vis.v} groupes={vis.g} mesGroupes={mesGroupes} onChange={(v, g) => setVis({ v, g })} />
            {element.type === "dossier" && (
              <p className="text-xs text-muted-foreground">
                {t("Chaque document garde sa propre visibilité : changer celle du dossier ne change pas celle de ce qu'il contient.")}
              </p>
            )}
          </>
        )}
        {mode === "deplacer" && <ChoixDestination exclu={element.id} valeur={destination} onChange={setDestination} />}
      </div>
      {erreur && (
        <InfoBox tone="warning" className="mt-3">
          {erreur}
        </InfoBox>
      )}
      <div className="mt-5 flex justify-end gap-2">
        <Button variant="secondary" onClick={onFermer}>
          {t("Annuler")}
        </Button>
        <Button disabled={!pret} onClick={enregistrer}>
          {mode === "deplacer" ? t("Déplacer ici") : t("Enregistrer")}
        </Button>
      </div>
    </Modal>
  );
}

/** Choisir un dossier de destination, en naviguant. */
function ChoixDestination({
  exclu,
  valeur,
  onChange,
}: {
  exclu: string;
  valeur: { id: string | null; nom: string } | null;
  onChange: (d: { id: string | null; nom: string }) => void;
}) {
  const [ici, setIci] = useState<{ id: string | null; nom: string }>({ id: null, nom: t("Fichiers") });
  const [pile, setPile] = useState<{ id: string | null; nom: string }[]>([]);
  const [dossiers, setDossiers] = useState<ElementBibliotheque[] | null>(null);
  useEffect(() => {
    setDossiers(null);
    void listerBibliotheque({ dossier: ici.id })
      .then((l) => setDossiers(l.elements.filter((e) => e.type === "dossier" && e.id !== exclu)))
      .catch(() => setDossiers([]));
  }, [ici.id, exclu]);
  useEffect(() => onChange(ici), [ici, onChange]);
  return (
    <div className="rounded-xl border border-border">
      <div className="flex items-center gap-2 border-b border-border px-3 py-2 text-sm">
        {pile.length > 0 && (
          <button
            type="button"
            onClick={() => {
              setIci(pile[pile.length - 1]!);
              setPile(pile.slice(0, -1));
            }}
            className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground"
          >
            <ChevronLeft size={15} strokeWidth={1.75} />{" "}{t("Retour")}
          </button>
        )}
        <span className="truncate font-medium text-foreground">{ici.nom}</span>
      </div>
      <ul className="max-h-56 overflow-y-auto p-1">
        {dossiers === null && (
          <li className="flex justify-center py-5 text-muted-foreground">
            <Loader2 size={16} className="animate-spin" />
          </li>
        )}
        {dossiers?.length === 0 && <li className="py-5 text-center text-sm text-muted-foreground">{t("Aucun sous-dossier.")}</li>}
        {dossiers?.map((d) => (
          <li key={d.id}>
            <button
              type="button"
              onClick={() => {
                setPile([...pile, ici]);
                setIci({ id: d.id, nom: d.nom });
              }}
              className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-start text-sm hover:bg-muted"
            >
              {d.emoji ? <span>{d.emoji}</span> : <Folder size={15} strokeWidth={1.75} className={classeCouleur(d.couleur)} />}
              <span className="min-w-0 flex-1 truncate text-foreground">{d.nom}</span>
              <ChevronRight size={15} strokeWidth={1.75} className="text-muted-foreground" />
            </button>
          </li>
        ))}
      </ul>
      <p className="border-t border-border px-3 py-2 text-xs text-muted-foreground">
        {t("Destination :")}{" "}<span className="text-foreground">{valeur?.nom ?? ici.nom}</span>
      </p>
    </div>
  );
}

function SuppressionModal({
  element,
  onFermer,
  onFait,
}: {
  element: ElementBibliotheque;
  onFermer: () => void;
  onFait: () => Promise<void>;
}) {
  const [occupe, setOccupe] = useState(false);
  const [erreur, setErreur] = useState<string | null>(null);
  return (
    <>
      <h2 className="pe-8 text-lg font-semibold text-foreground">
        {t("Supprimer")}{" "}{element.type === "dossier" ? "le dossier" : "le document"} ?
      </h2>
      <p className="mt-2 text-sm text-muted-foreground">
        « {element.nom} »{element.type === "dossier" ? t(" et tout ce qu'il contient") : ""}{" "}{t("disparaîtra pour tous ceux qui y avaient accès. C'est définitif.")}
      </p>
      {erreur && (
        <InfoBox tone="warning" className="mt-3">
          {erreur}
        </InfoBox>
      )}
      <div className="mt-5 flex justify-end gap-2">
        <Button variant="secondary" onClick={onFermer}>
          {t("Annuler")}
        </Button>
        <Button
          variant="destructive"
          disabled={occupe}
          onClick={() => {
            setOccupe(true);
            void supprimerElement(element.id)
              .then(onFait)
              .catch((err) => {
                setErreur(message(err));
                setOccupe(false);
              });
          }}
        >
          {t("Supprimer")}
        </Button>
      </div>
    </>
  );
}

export default BibliothequePage;
