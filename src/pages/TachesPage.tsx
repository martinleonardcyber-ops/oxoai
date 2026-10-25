import { useEffect, useMemo, useState } from "react";
import {
  Plus,
  Folder,
  Inbox,
  ListTodo,
  Sun,
  CalendarRange,
  LayoutGrid,
  Table as TableIcon,
  Calendar as CalendarIcon,
  Search,
  Filter,
  ArrowUpDown,
  ArrowUp,
  ArrowDown,
  Circle,
  Clock,
  CircleCheck,
  CircleX,
  ChevronLeft,
  ChevronRight,
  Check,
  X,
  User,
  Flag,
  FolderKanban,
  Bot,
  Play,
  Square,
  Wrench,
  Loader2,
  Trash2,
  TriangleAlert,
  Link2,
  Hourglass,
  CalendarClock,
  PanelLeftClose,
  PanelLeftOpen,
  Maximize2,
  Download,
  Copy,
} from "lucide-react";
import { Button } from "@/components/ui/Button";
import { IconButton } from "@/components/ui/IconButton";
import { SegmentedTabs } from "@/components/ui/SegmentedTabs";
import { Modal } from "@/components/ui/Modal";
import { Select } from "@/components/ui/Select";
import { Popover } from "@/components/ui/Popover";
import { Input } from "@/components/ui/Field";
import { Switch } from "@/components/ui/Switch";
import { cn } from "@/lib/cn";
import { TexteRiche } from "@/components/ui/TexteRiche";
import { copierTexte } from "@/lib/pressePapiers";
import { useTasks } from "@/hooks/useTasks";
import { useAgents } from "@/hooks/useAgents";
import { useProjects } from "@/hooks/useProjects";
import { DEFAULT_AGENT } from "@/lib/store/agents";
import { currentUser } from "@/lib/store/identity";
import type { Project } from "@/lib/store/projects";
import {
  STATUSES,
  creeUneBoucle,
  etatPrerequis,
  suitesDe,
  type EtatPrerequis,
  dateDuJour,
  echeanceDe,
  jourDe,
  situation,
  type Task,
  type TaskStatus,
  type TaskPriority,
} from "@/lib/store/tasks";
import { useFormats } from "@/lib/formats";
import { features } from "@/config/branding";
import { libelleOutil } from "@/lib/libellesOutils";
import { locale, sens, t, tf, lister } from "@/lib/i18n";
import { TachesProgrammees } from "@/components/taches/TachesProgrammees";

/* ========================================================================== */
/* Vues de gauche                                                              */
/* ========================================================================== */

/**
 * Rubrique choisie à gauche : une des quatre vues fixes, ou un projet
 * (« projet:<id> »).
 *
 * Définition exacte de chaque vue. « Aujourd'hui » est le jour du poste qui
 * affiche, recalculé à chaque rendu (pas figé au chargement de la page).
 *
 * - **Boîte de réception** : tâches **sans échéance et sans projet**. C'est ce
 *   qui n'a encore été ni daté ni rangé. Un projet que la personne ne voit plus
 *   (supprimé, ou dont on l'a retirée) compte comme « sans projet » : sans
 *   cela, la tâche ne serait plus dans aucune rubrique de rangement.
 * - **Mes tâches** : toutes les tâches dont la personne est propriétaire, quels
 *   que soient le projet, l'échéance et le statut. C'est la vue d'ensemble.
 * - **Aujourd'hui** : tâches dont l'échéance est aujourd'hui, quel que soit
 *   leur statut, **plus les tâches en retard** : échéance passée et tâche
 *   encore ouverte (ni terminée ni annulée). Les retards y portent la mention
 *   « En retard ». Une tâche close à l'échéance passée n'y figure pas : elle
 *   n'appelle plus rien aujourd'hui.
 * - **À venir** : échéance strictement postérieure à aujourd'hui, tout statut.
 * - **Projet** : tâches rangées dans ce projet.
 *
 * Toutes ces vues partent des tâches que la personne voit, c'est-à-dire des
 * siennes (`visibleTo`, même règle que `voitTache` dans la passerelle). Un
 * projet partagé ne montre donc pas les tâches des autres membres.
 */
type RubriqueFixe = "inbox" | "mine" | "today" | "upcoming";

const RUBRIQUES: { id: RubriqueFixe; label: string; icon: typeof Inbox }[] = [
  { id: "inbox", label: t("Boîte de réception"), icon: Inbox },
  { id: "mine", label: t("Mes tâches"), icon: ListTodo },
  { id: "today", label: t("Aujourd'hui"), icon: Sun },
  { id: "upcoming", label: t("À venir"), icon: CalendarRange },
];

const PREFIXE_PROJET = "projet:";
/** La rubrique des tâches programmées (TachesProgrammees.tsx) : ni des cartes, ni un projet. */
const RUBRIQUE_PROGRAMMEES = "programmees";

interface Contexte {
  moi: string;
  aujourdhui: string;
  /** Projets que la personne voit : les autres identifiants valent « sans projet ». */
  projets: Set<string>;
}

function dansRubrique(task: Task, rubrique: string, ctx: Contexte): boolean {
  // Garde de principe : même si le cache local contenait la tâche d'une
  // autre personne, aucune vue ne la montrerait.
  if (task.ownerId !== ctx.moi) return false;

  if (rubrique.startsWith(PREFIXE_PROJET)) {
    return task.projectId === rubrique.slice(PREFIXE_PROJET.length);
  }
  const s = situation(task, ctx.aujourdhui);
  switch (rubrique) {
    case "inbox":
      return s === "aucune" && !(task.projectId && ctx.projets.has(task.projectId));
    case "today":
      return s === "aujourdhui" || s === "retard";
    case "upcoming":
      return s === "avenir";
    default:
      return true; // « Mes tâches »
  }
}

/* ========================================================================== */
/* Tri et filtres                                                              */
/* ========================================================================== */

type ChampTri = "echeance" | "priorite" | "maj";
type Sens = "asc" | "desc";

const CHAMPS_TRI: {
  id: ChampTri;
  label: string;
  /** Ce que veut dire chaque sens pour ce champ, en clair. */
  asc: string;
  desc: string;
}[] = [
  { id: "echeance", label: t("Échéance"), asc: t("la plus proche d'abord"), desc: t("la plus lointaine d'abord") },
  { id: "priorite", label: t("Priorité"), asc: t("basse d'abord"), desc: t("haute d'abord") },
  { id: "maj", label: t("Date de mise à jour"), asc: t("la plus ancienne d'abord"), desc: t("la plus récente d'abord") },
];

const RANG_PRIORITE: Record<TaskPriority, number> = { basse: 0, moyenne: 1, haute: 2 };

/**
 * Trie sans modifier la liste reçue.
 *
 * Les tâches sans échéance vont **toujours en fin de liste** quand on trie par
 * échéance, dans un sens comme dans l'autre : une tâche non datée n'est ni la
 * plus proche ni la plus lointaine, et la mettre en tête d'un tri décroissant
 * enterrerait les vraies échéances. À égalité, la plus récemment modifiée
 * passe devant, pour que l'ordre ne saute pas d'un rendu à l'autre.
 */
function trier(tasks: Task[], champ: ChampTri, sens: Sens): Task[] {
  const facteur = sens === "asc" ? 1 : -1;
  const departage = (a: Task, b: Task) => b.updatedAt.localeCompare(a.updatedAt);
  return [...tasks].sort((a, b) => {
    let ecart = 0;
    if (champ === "echeance") {
      const ea = echeanceDe(a);
      const eb = echeanceDe(b);
      if (!ea || !eb) {
        if (ea) return -1;
        if (eb) return 1;
        return departage(a, b);
      }
      ecart = ea.localeCompare(eb);
    } else if (champ === "priorite") {
      ecart = RANG_PRIORITE[a.priority] - RANG_PRIORITE[b.priority];
    } else {
      ecart = a.updatedAt.localeCompare(b.updatedAt);
    }
    return ecart !== 0 ? ecart * facteur : departage(a, b);
  });
}

type Vue = "kanban" | "tableau" | "calendrier";
type ModeCalendrier = "semaine" | "mois";

/**
 * Préférences d'affichage de l'écran, pour une personne sur ce poste.
 *
 * Rangées dans le `localStorage` et non dans le profil synchronisé : c'est un
 * confort de lecture propre à un écran et à une machine (un grand écran au
 * bureau appelle le tableau, un portable le Kanban). Les perdre ne coûte
 * qu'un clic, d'où le try/catch sans autre recours.
 *
 * Un filtre vide veut dire « pas de filtre » sur ce critère.
 */
interface Preferences {
  vue: Vue;
  modeCalendrier: ModeCalendrier;
  rubrique: string;
  statuts: TaskStatus[];
  priorites: TaskPriority[];
  agents: string[];
  tri: ChampTri;
  sens: Sens;
}

const PREFERENCES_DEFAUT: Preferences = {
  vue: "kanban",
  modeCalendrier: "semaine",
  rubrique: "mine",
  statuts: [],
  priorites: [],
  agents: [],
  tri: "maj",
  sens: "desc",
};

/* La clé porte le compte : deux personnes qui partagent un poste gardent chacune leurs réglages. */
const clePreferences = (userId: string) => `oxoai:preferences-taches:${userId}`;

/** Garde d'une liste relue : seules les valeurs connues survivent. */
function listeDe<T extends string>(brut: unknown, permises: readonly T[]): T[] {
  return Array.isArray(brut) ? brut.filter((v): v is T => permises.includes(v as T)) : [];
}

function lirePreferences(userId: string): Preferences {
  try {
    const brut = JSON.parse(localStorage.getItem(clePreferences(userId)) ?? "null") as
      | Record<string, unknown>
      | null;
    if (!brut || typeof brut !== "object") return PREFERENCES_DEFAUT;
    const un = <T extends string>(v: unknown, permises: readonly T[], defaut: T): T =>
      permises.includes(v as T) ? (v as T) : defaut;
    return {
      vue: un(brut.vue, ["kanban", "tableau", "calendrier"] as const, PREFERENCES_DEFAUT.vue),
      modeCalendrier: un(brut.modeCalendrier, ["semaine", "mois"] as const, "semaine"),
      rubrique:
        typeof brut.rubrique === "string" &&
        (RUBRIQUES.some((r) => r.id === brut.rubrique) ||
          brut.rubrique === RUBRIQUE_PROGRAMMEES ||
          (brut.rubrique as string).startsWith(PREFIXE_PROJET))
          ? (brut.rubrique as string)
          : PREFERENCES_DEFAUT.rubrique,
      statuts: listeDe(brut.statuts, STATUSES.map((s) => s.id)),
      priorites: listeDe(brut.priorites, ["basse", "moyenne", "haute"] as const),
      // Les agents se créent et se suppriment : on garde les identifiants tels
      // quels, un agent disparu ne filtre simplement plus rien.
      agents: Array.isArray(brut.agents)
        ? brut.agents.filter((a): a is string => typeof a === "string")
        : [],
      tri: un(brut.tri, ["echeance", "priorite", "maj"] as const, PREFERENCES_DEFAUT.tri),
      sens: un(brut.sens, ["asc", "desc"] as const, PREFERENCES_DEFAUT.sens),
    };
  } catch {
    return PREFERENCES_DEFAUT;
  }
}

function ecrirePreferences(userId: string, prefs: Preferences): void {
  try {
    localStorage.setItem(clePreferences(userId), JSON.stringify(prefs));
  } catch {
    /* stockage plein ou refusé : le réglage vaudra pour cette visite seulement */
  }
}

/* ========================================================================== */
/* Libellés et styles                                                          */
/* ========================================================================== */

const viewTabs = [
  { id: "kanban", label: t("Kanban"), icon: LayoutGrid },
  { id: "tableau", label: t("Tableau"), icon: TableIcon },
  { id: "calendrier", label: t("Calendrier"), icon: CalendarIcon },
];

const columnMeta: Record<TaskStatus, { icon: typeof Circle; color: string }> = {
  "a-faire": { icon: Circle, color: "text-muted-foreground" },
  "en-cours": { icon: Clock, color: "text-warning" },
  terminee: { icon: CircleCheck, color: "text-success" },
  annulee: { icon: CircleX, color: "text-destructive" },
};

const PRIORITES: { id: TaskPriority; label: string }[] = [
  { id: "haute", label: t("Haute") },
  { id: "moyenne", label: t("Moyenne") },
  { id: "basse", label: t("Basse") },
];

const priorityLabel: Record<TaskPriority, string> = {
  basse: t("Basse"),
  moyenne: t("Moyenne"),
  haute: t("Haute"),
};

const priorityClass: Record<TaskPriority, string> = {
  basse: "bg-muted text-muted-foreground",
  moyenne: "bg-info/15 text-info",
  haute: "bg-destructive/15 text-destructive",
};

/*
 * Les jours de la semaine, du lundi au dimanche, dans la langue affichée : ils
 * étaient écrits en français (« LUN », « MAR ») et le restaient dans les six
 * autres langues (vu à l'écran le 30/09/2026, en arabe). Le 1er janvier 2024
 * est un lundi. En arabe, l'abréviation n'existe pas : le petit calendrier
 * prend la lettre du jour, le grand son nom entier.
 */
const nomsDesJours = (forme: "short" | "narrow"): string[] =>
  Array.from({ length: 7 }, (_, i) => new Date(2024, 0, 1 + i).toLocaleDateString(locale(), { weekday: forme }).replace(/\.$/, ""));
const joursCourts = (): string[] => (sens() === "rtl" ? nomsDesJours("narrow") : nomsDesJours("short").map((n) => n.slice(0, 2)));

/* ========================================================================== */
/* Calendrier : calculs de jours                                               */
/* ========================================================================== */

/** Décale une date d'un nombre de jours, sans toucher à l'originale. */
function decaler(ref: Date, jours: number): Date {
  const suivant = new Date(ref.getFullYear(), ref.getMonth(), ref.getDate());
  suivant.setDate(suivant.getDate() + jours);
  return suivant;
}

/** Lundi de la semaine d'une date (les semaines françaises commencent le lundi). */
function lundiDe(ref: Date): Date {
  return decaler(ref, -((ref.getDay() + 6) % 7));
}

/** Les sept jours de la semaine d'une date. */
function joursSemaine(ref: Date): Date[] {
  const lundi = lundiDe(ref);
  return Array.from({ length: 7 }, (_, i) => decaler(lundi, i));
}

/**
 * Grille d'un mois : des semaines entières, du lundi qui précède (ou qui est)
 * le 1er jusqu'au dimanche qui suit le dernier jour.
 */
function joursMois(ref: Date): Date[] {
  const premier = new Date(ref.getFullYear(), ref.getMonth(), 1);
  const dernier = new Date(ref.getFullYear(), ref.getMonth() + 1, 0);
  const debut = lundiDe(premier);
  const fin = decaler(lundiDe(dernier), 6);
  const jours: Date[] = [];
  for (let d = debut; d <= fin; d = decaler(d, 1)) jours.push(d);
  return jours;
}

/** Aujourd'hui, au format stocké. Lu à l'appel : la page peut rester ouverte passé minuit. */
const aujourdhuiJour = () => jourDe(new Date());

/* ========================================================================== */
/* Petits composants                                                           */
/* ========================================================================== */

/**
 * Pastille d'échéance d'une tâche. Le retard se dit en toutes lettres, pas
 * seulement en rouge : une couleur seule ne se lit pas partout.
 */
function Echeance({ task, compact }: { task: Task; compact?: boolean }) {
  const { date } = useFormats();
  const jour = dateDuJour(task.dueDate);
  if (!jour) return null;
  const s = situation(task, aujourdhuiJour());
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium",
        s === "retard"
          ? "bg-destructive/15 text-destructive"
          : s === "aujourdhui"
            ? "bg-warning/15 text-warning"
            : "bg-muted text-muted-foreground",
      )}
    >
      {s === "retard" ? (
        <TriangleAlert size={11} strokeWidth={2} />
      ) : (
        <CalendarIcon size={11} strokeWidth={2} />
      )}
      {s === "retard"
        ? compact
          ? t("En retard")
          : tf("En retard · {0}", date(jour))
        : s === "aujourdhui"
          ? t("Aujourd'hui")
          : date(jour)}
    </span>
  );
}

/** Mini calendrier mensuel pour choisir un jour, sans le sélecteur natif du navigateur. */
function MiniCalendrier({
  valeur,
  onChoisir,
}: {
  valeur: string | null;
  onChoisir: (jour: string) => void;
}) {
  const { moisAnnee } = useFormats();
  const [mois, setMois] = useState(() => dateDuJour(valeur ?? undefined) ?? new Date());
  const jours = joursMois(mois);
  const aujourdhui = aujourdhuiJour();

  return (
    <div className="p-1">
      <div className="mb-1 flex items-center justify-between">
        <IconButton
          icon={ChevronLeft}
          label={t("Mois précédent")}
          size={26}
          iconSize={15}
          onClick={() => setMois((m) => new Date(m.getFullYear(), m.getMonth() - 1, 1))}
        />
        <span className="text-sm font-medium capitalize text-foreground">{moisAnnee(mois)}</span>
        <IconButton
          icon={ChevronRight}
          label={t("Mois suivant")}
          size={26}
          iconSize={15}
          onClick={() => setMois((m) => new Date(m.getFullYear(), m.getMonth() + 1, 1))}
        />
      </div>
      <div className="grid grid-cols-7 gap-0.5 text-center">
        {joursCourts().map((n, i) => (
          <span key={i} className="py-1 text-[10px] font-medium uppercase text-muted-foreground">
            {n}
          </span>
        ))}
        {jours.map((d) => {
          const jour = jourDe(d);
          const horsMois = d.getMonth() !== mois.getMonth();
          return (
            <button
              key={jour}
              type="button"
              aria-label={jour}
              onClick={() => onChoisir(jour)}
              className={cn(
                "h-8 rounded-md text-xs transition-colors",
                jour === valeur
                  ? "bg-primary font-semibold text-primary-foreground"
                  : "hover:bg-muted",
                jour !== valeur && horsMois && "text-muted-foreground/60",
                jour !== valeur && !horsMois && "text-foreground",
                jour === aujourdhui && jour !== valeur && "ring-1 ring-inset ring-border font-semibold",
              )}
            >
              {d.getDate()}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** Champ d'échéance : raccourcis courants, calendrier, ou aucune date. */
function ChampEcheance({
  valeur,
  onChange,
}: {
  valeur: string | null;
  onChange: (jour: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const { date } = useFormats();
  const jour = dateDuJour(valeur ?? undefined);
  const aujourdhui = new Date();

  const choisir = (v: string | null) => {
    onChange(v);
    setOpen(false);
  };

  const raccourcis = [
    { label: t("Aujourd'hui"), jour: jourDe(aujourdhui) },
    { label: t("Demain"), jour: jourDe(decaler(aujourdhui, 1)) },
    { label: t("Dans une semaine"), jour: jourDe(decaler(aujourdhui, 7)) },
  ];

  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      side="top"
      width={272}
      className="w-full"
      trigger={(p) => (
        <button
          type="button"
          onClick={p.onClick}
          aria-expanded={p["aria-expanded"]}
          className="flex w-full items-center justify-between gap-2 rounded-lg border border-input bg-card px-3 py-2.5 text-sm transition-colors hover:bg-muted/40"
        >
          <span className={cn(!jour && "text-muted-foreground")}>
            {jour ? date(jour) : t("Aucune date")}
          </span>
          <CalendarIcon size={16} strokeWidth={1.75} className="shrink-0 text-muted-foreground" />
        </button>
      )}
    >
      <div className="flex flex-wrap gap-1 px-1 pb-1.5">
        {raccourcis.map((r) => (
          <button
            key={r.label}
            type="button"
            onClick={() => choisir(r.jour)}
            className="rounded-full bg-muted px-2.5 py-1 text-xs text-foreground transition-colors hover:bg-muted/70"
          >
            {r.label}
          </button>
        ))}
        {jour && (
          <button
            type="button"
            onClick={() => choisir(null)}
            className="rounded-full px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            {t("Aucune date")}
          </button>
        )}
      </div>
      <MiniCalendrier valeur={valeur} onChoisir={(v) => choisir(v)} />
    </Popover>
  );
}

/**
 * Les tâches à terminer avant celle-ci. Une tâche qui créerait une boucle
 * (elle-même, ou une tâche qui l'attend déjà) est montrée, grisée, avec la
 * raison : la retirer de la liste laisserait croire qu'elle a disparu.
 */
function ChoixPrerequis({
  tacheId,
  valeur,
  onChange,
  taches,
}: {
  /** Absent à la création : la tâche n'existe pas encore, aucune boucle possible. */
  tacheId?: string;
  valeur: string[];
  onChange: (ids: string[]) => void;
  taches: Task[];
}) {
  const [open, setOpen] = useState(false);
  const [recherche, setRecherche] = useState("");
  const parId = new Map(taches.map((tache) => [tache.id, tache]));
  const choisies = valeur
    .map((id) => parId.get(id))
    .filter((tache): tache is Task => Boolean(tache));
  const q = recherche.trim().toLowerCase();
  const candidates = taches
    .filter((tache) => tache.id !== tacheId && (!q || tache.title.toLowerCase().includes(q)))
    // Les tâches ouvertes d'abord : c'est à elles qu'on enchaîne le plus souvent.
    .sort((a, b) => Number(a.status === "terminee" || a.status === "annulee") - Number(b.status === "terminee" || b.status === "annulee") || b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, 50);
  const resume =
    choisies.length === 0
      ? t("Aucune")
      : choisies.length === 1
        ? `« ${choisies[0]!.title} »`
        : choisies.length === 2
          ? tf("« {0} » et 1 autre", choisies[0]!.title)
          : tf("« {0} » et {1} autres", choisies[0]!.title, choisies.length - 1);

  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      side="top"
      width={320}
      className="w-full"
      trigger={(p) => (
        <button
          type="button"
          onClick={p.onClick}
          aria-expanded={p["aria-expanded"]}
          className="flex w-full items-center justify-between gap-2 rounded-lg border border-input bg-card px-3 py-2.5 text-sm transition-colors hover:bg-muted/40"
        >
          <span className={cn("min-w-0 truncate", choisies.length === 0 && "text-muted-foreground")}>{resume}</span>
          <Link2 size={16} strokeWidth={1.75} className="shrink-0 text-muted-foreground" />
        </button>
      )}
    >
      <div className="px-1 pb-1.5">
        <Input placeholder={t("Chercher une tâche…")} value={recherche} onChange={(e) => setRecherche(e.target.value)} aria-label={t("Chercher une tâche")} />
      </div>
      <div className="max-h-64 overflow-y-auto">
        {candidates.length === 0 && <p className="px-2.5 py-2 text-sm text-muted-foreground">{t("Aucune autre tâche.")}</p>}
        {candidates.map((tache) => {
          const boucle = Boolean(tacheId) && creeUneBoucle(tacheId!, tache.id, taches);
          if (boucle && !valeur.includes(tache.id)) {
            return (
              <div key={tache.id} className="flex items-center gap-2 px-2.5 py-1.5 text-sm text-muted-foreground" title={t("Elle attend déjà celle-ci : aucune des deux ne partirait.")}>
                <span className="h-4 w-4 shrink-0 rounded border border-muted-foreground/30" />
                <span className="min-w-0 flex-1 truncate">{tache.title}</span>
                <span className="shrink-0 text-[11px]">{t("attend celle-ci")}</span>
              </div>
            );
          }
          return (
            <CaseFiltre key={tache.id} coche={valeur.includes(tache.id)} onClick={() => onChange(basculer(valeur, tache.id))}>
              {tache.title}
              {tache.status !== "a-faire" && (
                <span className="ms-1.5 text-[11px] text-muted-foreground">
                  {STATUSES.find((s) => s.id === tache.status)?.label.toLowerCase()}
                </span>
              )}
            </CaseFiltre>
          );
        })}
      </div>
    </Popover>
  );
}

/** « D'elle-même, dès qu'elle est terminée » : accordé au nombre de tâches attendues. */
function libelleLancement(auto: boolean, nombre: number): string {
  const fin = nombre > 1 ? t("qu'elles sont terminées") : t("qu'elle est terminée");
  return auto ? tf("D'elle-même, dès {0}", fin) : tf("À la main, une fois {0}", fin);
}

/** Ce que dit une carte qui attend : qui elle attend, ou ce qui la bloque. */
function attenteDe(prerequis: EtatPrerequis): string | null {
  if (prerequis.bloque.length > 0) {
    const t = prerequis.bloque[0]!;
    /* Une phrase par nombre (28/09/2026) : « , et N autre(s) » était collé en français dans toutes les langues. */
    if (prerequis.bloque.length === 1) return tf("Bloquée : « {0} » a été annulée", t.title);
    if (prerequis.bloque.length === 2) return tf("Bloquée : « {0} » a été annulée, et 1 autre", t.title);
    return tf("Bloquée : « {0} » a été annulée, et {1} autres", t.title, prerequis.bloque.length - 1);
  }
  if (prerequis.attend.length > 0) {
    const t = prerequis.attend[0]!;
    if (prerequis.attend.length === 1) return tf("Après « {0} »", t.title);
    if (prerequis.attend.length === 2) return tf("Après « {0} » et 1 autre", t.title);
    return tf("Après « {0} » et {1} autres", t.title, prerequis.attend.length - 1);
  }
  return null;
}

/** Case d'un menu de filtre : un critère coché ou non. */
function CaseFiltre({
  coche,
  onClick,
  children,
}: {
  coche: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      role="menuitemcheckbox"
      aria-checked={coche}
      onClick={onClick}
      className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-start text-sm text-foreground transition-colors hover:bg-muted"
    >
      <span
        className={cn(
          "flex h-4 w-4 shrink-0 items-center justify-center rounded border",
          // Le bord d'un champ (`border-input`) disparaît presque sur le fond
          // sombre d'un menu : une case vide doit rester visible comme case.
          coche
            ? "border-primary bg-primary text-primary-foreground"
            : "border-muted-foreground/60 bg-transparent",
        )}
      >
        {coche && <Check size={11} strokeWidth={3} />}
      </span>
      <span className="min-w-0 flex-1 truncate">{children}</span>
    </button>
  );
}

const basculer = <T,>(liste: T[], valeur: T): T[] =>
  liste.includes(valeur) ? liste.filter((v) => v !== valeur) : [...liste, valeur];

/* ========================================================================== */
/* Compte rendu d'une tâche : agrandir, copier, télécharger                    */
/* ========================================================================== */

/*
 * Demandé par Medhi le 28/09/2026 : un compte rendu long (résumé de mails, plan)
 * se lisait mal dans sa petite case. On peut l'ouvrir en grand, le copier, ou
 * l'enregistrer en Markdown, titre de la tâche en tête.
 */
function nomDeFichierCompteRendu(titre: string): string {
  const base =
    titre
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^A-Za-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 60) || "tache";
  return `${base}-compte-rendu.md`;
}

function telechargerCompteRendu(titre: string, texte: string) {
  const fichier = new Blob([`# ${titre}\n\n${texte.trim()}\n`], { type: "text/markdown;charset=utf-8" });
  const adresse = URL.createObjectURL(fichier);
  const lien = document.createElement("a");
  lien.href = adresse;
  lien.download = nomDeFichierCompteRendu(titre);
  document.body.appendChild(lien);
  lien.click();
  lien.remove();
  // Laisse au navigateur le temps de lire le fichier avant de le libérer.
  setTimeout(() => URL.revokeObjectURL(adresse), 60_000);
}

function ActionsCompteRendu({ titre, texte, onAgrandir }: { titre: string; texte: string; onAgrandir?: () => void }) {
  const [copie, setCopie] = useState(false);
  return (
    <div className="flex shrink-0 items-center gap-0.5">
      {onAgrandir && <IconButton icon={Maximize2} label={t("Agrandir")} size={28} iconSize={15} onClick={onAgrandir} />}
      <IconButton
        icon={copie ? Check : Copy}
        label={copie ? t("Copié") : t("Copier")}
        size={28}
        iconSize={15}
        onClick={() =>
          void copierTexte(texte).then((ok) => {
            if (!ok) return;
            setCopie(true);
            setTimeout(() => setCopie(false), 1500);
          })
        }
      />
      <IconButton icon={Download} label={t("Télécharger")} size={28} iconSize={15} onClick={() => telechargerCompteRendu(titre, texte)} />
    </div>
  );
}

/* ========================================================================== */
/* Panneau de gauche                                                           */
/* ========================================================================== */

/** Colonne des rubriques réduite à ses icônes, sur ce poste. */
const CLE_COLONNE_REDUITE = "oxoai.taches.colonneReduite";

function ProjectsPanel({
  rubrique,
  onRubrique,
  projets,
  compteurs,
  onNouveauProjet,
}: {
  rubrique: string;
  onRubrique: (id: string) => void;
  projets: Project[];
  compteurs: Map<string, number>;
  onNouveauProjet: () => void;
}) {
  /*
   * Colonne réduite à ses icônes, pour donner la largeur au tableau et au
   * Kanban (demandé par Medhi le 28/09/2026). Retenue sur ce poste seulement :
   * un confort d'affichage, pas une donnée.
   */
  const [reduite, setReduite] = useState(() => {
    try {
      return localStorage.getItem(CLE_COLONNE_REDUITE) === "1";
    } catch {
      return false;
    }
  });
  const basculerColonne = () =>
    setReduite((r) => {
      try {
        localStorage.setItem(CLE_COLONNE_REDUITE, r ? "0" : "1");
      } catch {
        /* sans stockage, le choix vaut pour cette visite */
      }
      return !r;
    });
  const entree = (actif: boolean) =>
    cn(
      "flex shrink-0 items-center gap-2.5 whitespace-nowrap rounded-lg px-2.5 py-2 text-sm transition-colors md:w-full",
      reduite && "md:justify-center md:px-0",
      actif
        ? "bg-muted font-medium text-foreground"
        : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
    );
  /** Le libellé et le compteur disparaissent en colonne réduite (écran large seulement). */
  const cache = reduite ? "md:hidden" : "";

  return (
    /*
     * Sous 768 pixels, une rangée au-dessus des tâches, comme la liste des
     * Paramètres (28/09/2026) : à 375 pixels, la colonne de 236 pixels ne
     * laissait que 62 pixels au tableau, et « Aucune tâche » s'écrivait une
     * lettre par ligne.
     */
    <aside
      className={cn(
        "flex shrink-0 gap-1 overflow-x-auto border-b border-border px-2 py-2 md:flex-col md:overflow-y-auto md:overflow-x-hidden md:border-b-0 md:border-e md:p-0 md:transition-[width]",
        reduite ? "md:w-[56px]" : "md:w-[236px]",
      )}
    >
      <div className={cn("hidden md:flex md:px-2 md:pt-3", reduite ? "md:justify-center" : "md:justify-end")}>
        <IconButton
          icon={reduite ? PanelLeftOpen : PanelLeftClose}
          label={reduite ? t("Déplier la colonne") : t("Réduire la colonne")}
          size={28}
          iconSize={16}
          onClick={basculerColonne}
        />
      </div>
      <nav className="flex gap-1 md:block md:space-y-0.5 md:px-2 md:pt-1">
        {RUBRIQUES.map((r) => {
          const Icon = r.icon;
          const n = compteurs.get(r.id) ?? 0;
          return (
            <button
              key={r.id}
              type="button"
              aria-current={rubrique === r.id ? "page" : undefined}
              onClick={() => onRubrique(r.id)}
              className={entree(rubrique === r.id)}
              title={reduite ? r.label : undefined}
            >
              <Icon size={16} strokeWidth={1.75} className="shrink-0" />
              <span className={cn("min-w-0 flex-1 truncate text-start", cache)}>{r.label}</span>
              {n > 0 && <span className={cn("text-xs text-muted-foreground", cache)}>{n}</span>}
            </button>
          );
        })}
        <button
          type="button"
          aria-current={rubrique === RUBRIQUE_PROGRAMMEES ? "page" : undefined}
          onClick={() => onRubrique(RUBRIQUE_PROGRAMMEES)}
          className={entree(rubrique === RUBRIQUE_PROGRAMMEES)}
          title={reduite ? t("Programmées") : undefined}
        >
          <CalendarClock size={16} strokeWidth={1.75} className="shrink-0" />
          <span className={cn("min-w-0 flex-1 truncate text-start", cache)}>{t("Programmées")}</span>
        </button>
      </nav>

      {features.projets && (
        <>
          <div className={cn("flex shrink-0 items-center md:pb-2 md:pt-6", reduite ? "md:justify-center" : "md:justify-between md:px-4")}>
            <span className={cn("hidden text-sm font-semibold text-foreground", !reduite && "md:inline")}>{t("Projets")}</span>
            <IconButton
              icon={Plus}
              label={t("Nouveau projet")}
              size={28}
              iconSize={16}
              onClick={onNouveauProjet}
            />
          </div>
          {projets.length === 0 ? (
            <div className={cn("mt-2 hidden flex-col items-center gap-3 px-4 text-center", !reduite && "md:flex")}>
              <Folder size={26} strokeWidth={1.25} className="text-muted-foreground" />
              <p className="text-xs text-muted-foreground">
                {t("Créez un projet pour organiser vos tâches")}
              </p>
              <Button variant="secondary" size="sm" icon={Plus} onClick={onNouveauProjet}>
                {t("Nouveau projet")}
              </Button>
            </div>
          ) : (
            <nav className="flex gap-1 md:block md:space-y-0.5 md:px-2">
              {projets.map((p) => {
                const id = `${PREFIXE_PROJET}${p.id}`;
                const n = compteurs.get(id) ?? 0;
                return (
                  <button
                    key={p.id}
                    type="button"
                    aria-current={rubrique === id ? "page" : undefined}
                    onClick={() => onRubrique(id)}
                    className={entree(rubrique === id)}
                    title={reduite ? p.name : undefined}
                  >
                    <Folder size={16} strokeWidth={1.75} className="shrink-0" />
                    <span className={cn("min-w-0 flex-1 truncate text-start", cache)}>{p.name}</span>
                    {n > 0 && <span className={cn("text-xs text-muted-foreground", cache)}>{n}</span>}
                  </button>
                );
              })}
            </nav>
          )}
          {/*
            Dit ce que le classement fait et ne fait pas : un projet partagé
            laisse croire que tout ce qu'on y range se partage avec lui.
          */}
          <p className={cn("mt-auto hidden px-4 pb-4 pt-6 text-[11px] leading-relaxed text-muted-foreground", !reduite && "md:block")}>
            {t("Vos tâches restent personnelles, même rangées dans un projet partagé.")}
          </p>
        </>
      )}
    </aside>
  );
}

/* ========================================================================== */
/* Carte                                                                       */
/* ========================================================================== */

function TaskCard({
  task,
  agentName,
  projectName,
  running,
  prerequis,
  onDelegate,
  onCancel,
  onOpen,
  onDelete,
}: {
  task: Task;
  agentName: string;
  projectName: string | null;
  running: boolean;
  /** Où en sont les tâches qu'elle attend. */
  prerequis: EtatPrerequis;
  onDelegate: () => void;
  onCancel: () => void;
  onOpen: () => void;
  onDelete: () => void;
}) {
  return (
    <div className="group rounded-xl border border-border bg-card p-3 shadow-sm transition-shadow hover:shadow-md">
      <div className="flex items-start gap-2">
        <button
          type="button"
          onClick={onOpen}
          className="min-w-0 flex-1 text-start text-sm font-medium text-foreground"
        >
          {task.title}
        </button>
        <button
          type="button"
          aria-label={tf("Supprimer {0}", task.title)}
          onClick={onDelete}
          className="hidden shrink-0 rounded p-0.5 text-muted-foreground transition-colors hover:text-destructive group-hover:block"
        >
          <Trash2 size={13} strokeWidth={1.75} />
        </button>
      </div>

      {task.description && (
        <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{task.description}</p>
      )}

      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <Echeance task={task} />
        <span
          className={cn(
            "rounded-full px-2 py-0.5 text-[11px] font-medium",
            priorityClass[task.priority],
          )}
        >
          {priorityLabel[task.priority]}
        </span>
        {projectName && (
          <span className="inline-flex max-w-full items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">
            <Folder size={11} strokeWidth={2} className="shrink-0" />
            <span className="truncate">{projectName}</span>
          </span>
        )}
        <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">
          <Bot size={11} strokeWidth={2} /> {agentName}
        </span>
        {task.toolLog && task.toolLog.length > 0 && (
          <span className="inline-flex items-center gap-1 rounded-full bg-accent/12 px-2 py-0.5 text-[11px] font-medium text-accent">
            <Wrench size={10} strokeWidth={2} /> {task.toolLog.length}
          </span>
        )}
      </div>

      {task.error && (
        <p className="mt-2 line-clamp-2 text-[11px] text-destructive">{task.error}</p>
      )}

      {!running && task.status === "a-faire" && attenteDe(prerequis) && (
        <p
          className={cn(
            "mt-2 flex items-start gap-1.5 text-[11px]",
            prerequis.bloque.length > 0 ? "text-destructive" : "text-muted-foreground",
          )}
        >
          <Link2 size={12} strokeWidth={2} className="mt-px shrink-0" />
          <span className="min-w-0">{attenteDe(prerequis)}</span>
        </p>
      )}

      <div className="mt-2.5">
        {running ? (
          <Button variant="secondary" size="sm" icon={Square} block onClick={onCancel}>
            {t("Interrompre")}
          </Button>
        ) : task.status === "a-faire" && !prerequis.pret ? (
          <Button variant="secondary" size="sm" icon={Hourglass} block disabled>
            {prerequis.bloque.length > 0 ? t("En attente d'une relance") : task.autoStart ? t("Partira d'elle-même") : t("En attente")}
          </Button>
        ) : task.status === "terminee" ? (
          <Button variant="secondary" size="sm" block onClick={onOpen}>
            {t("Voir le compte rendu")}
          </Button>
        ) : (
          <Button size="sm" icon={Play} block onClick={onDelegate}>
            {t("Déléguer à l'agent")}
          </Button>
        )}
      </div>
    </div>
  );
}

/* ========================================================================== */
/* Vues                                                                        */
/* ========================================================================== */

interface ViewProps {
  /** Tâches déjà filtrées (rubrique, recherche, filtres) et triées. */
  tasks: Task[];
  /** Statuts retenus par le filtre ; vide = tous. */
  statuts: TaskStatus[];
  agentName: (id?: string) => string;
  projectName: (id?: string) => string | null;
  runningIds: string[];
  /** Toutes les tâches de la personne, filtres compris ou non : une carte attend parfois une tâche masquée. */
  toutes: Task[];
  onDelegate: (t: Task) => void;
  onCancel: (id: string) => void;
  onOpen: (t: Task) => void;
  onDelete: (id: string) => void;
  onCreate: (init?: { status?: TaskStatus; dueDate?: string }) => void;
}

function KanbanView(props: ViewProps) {
  // Filtrer sur un statut masque les colonnes des autres : une colonne
  // toujours vide par construction ne dirait rien d'utile.
  const colonnes =
    props.statuts.length > 0 ? STATUSES.filter((s) => props.statuts.includes(s.id)) : STATUSES;
  return (
    <div className="flex h-full gap-4 overflow-x-auto px-6 py-5">
      {colonnes.map((col) => {
        const meta = columnMeta[col.id];
        const Icon = meta.icon;
        // L'ordre de `props.tasks` est celui du tri : on le garde dans chaque colonne.
        const items = props.tasks.filter((t) => t.status === col.id);
        return (
          <div key={col.id} className="flex w-[290px] shrink-0 flex-col">
            <div className="flex items-center gap-2 px-1 pb-3">
              <Icon size={15} strokeWidth={1.75} className={meta.color} />
              <span className="text-sm font-medium text-foreground">{col.label}</span>
              <span className="text-sm text-muted-foreground">{items.length}</span>
              <span className="ms-auto flex items-center gap-0.5">
                <IconButton
                  icon={Plus}
                  label={t("Ajouter une tâche")}
                  size={26}
                  iconSize={15}
                  onClick={() => props.onCreate({ status: col.id })}
                />
              </span>
            </div>
            {items.length === 0 ? (
              <div className="flex-1 py-10 text-center text-sm text-muted-foreground/70">
                {t("Aucune tâche")}
              </div>
            ) : (
              <div className="space-y-2">
                {items.map((t) => (
                  <TaskCard
                    key={t.id}
                    task={t}
                    agentName={props.agentName(t.agentId)}
                    projectName={props.projectName(t.projectId)}
                    running={props.runningIds.includes(t.id)}
                    prerequis={etatPrerequis(t, props.toutes)}
                    onDelegate={() => props.onDelegate(t)}
                    onCancel={() => props.onCancel(t.id)}
                    onOpen={() => props.onOpen(t)}
                    onDelete={() => props.onDelete(t.id)}
                  />
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function TableView({
  tasks,
  toutes,
  agentName,
  projectName,
  onOpen,
  tri,
  sens,
  onTri,
}: ViewProps & { tri: ChampTri; sens: Sens; onTri: (champ: ChampTri) => void }) {
  const { dateHeure } = useFormats();

  /*
   * Les en-têtes des colonnes triables trient pour de vrai : ils pilotent le
   * même réglage que le menu « Tri », et la flèche montre le sens en cours.
   */
  const colonnes: { label: string; champ?: ChampTri }[] = [
    { label: t("Titre") },
    { label: t("Statut") },
    { label: t("Priorité"), champ: "priorite" },
    { label: t("Échéance"), champ: "echeance" },
    { label: t("Projet") },
    { label: t("Agent") },
    { label: t("Outils") },
    { label: t("Mise à jour"), champ: "maj" },
  ];

  return (
    <div className="px-6 py-5">
      <div className="overflow-x-auto rounded-xl border border-border">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border bg-muted/30 text-start text-muted-foreground">
              {colonnes.map((c) => (
                <th
                  key={c.label}
                  className="whitespace-nowrap px-4 py-3 font-medium"
                  aria-sort={
                    c.champ && c.champ === tri
                      ? sens === "asc"
                        ? "ascending"
                        : "descending"
                      : undefined
                  }
                >
                  {c.champ ? (
                    <button
                      type="button"
                      onClick={() => onTri(c.champ!)}
                      className={cn(
                        "inline-flex items-center gap-1 transition-colors hover:text-foreground",
                        c.champ === tri && "text-foreground",
                      )}
                    >
                      {c.label}
                      {c.champ === tri &&
                        (sens === "asc" ? (
                          <ArrowUp size={13} strokeWidth={2} />
                        ) : (
                          <ArrowDown size={13} strokeWidth={2} />
                        ))}
                    </button>
                  ) : (
                    c.label
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {tasks.length === 0 ? (
              <tr>
                <td colSpan={colonnes.length} className="px-4 py-10 text-center text-muted-foreground">
                  {t("Aucune tâche")}
                </td>
              </tr>
            ) : (
              tasks.map((tache) => (
                <tr
                  key={tache.id}
                  onClick={() => onOpen(tache)}
                  className="cursor-pointer border-b border-border/60 last:border-0 hover:bg-muted/30"
                >
                  <td className="min-w-[14rem] px-4 py-2.5 font-medium text-foreground">
                    {tache.title}
                    {tache.status === "a-faire" && attenteDe(etatPrerequis(tache, toutes)) && (
                      <span className="mt-0.5 flex items-center gap-1 text-[11px] font-normal text-muted-foreground">
                        <Link2 size={11} strokeWidth={2} className="shrink-0" />
                        {attenteDe(etatPrerequis(tache, toutes))}
                      </span>
                    )}
                  </td>
                  <td className="whitespace-nowrap px-4 py-2.5 text-muted-foreground">
                    {STATUSES.find((s) => s.id === tache.status)?.label}
                  </td>
                  <td className="px-4 py-2.5">
                    <span
                      className={cn(
                        "rounded-full px-2 py-0.5 text-xs font-medium",
                        priorityClass[tache.priority],
                      )}
                    >
                      {priorityLabel[tache.priority]}
                    </span>
                  </td>
                  <td className="whitespace-nowrap px-4 py-2.5 text-muted-foreground">
                    {echeanceDe(tache) ? <Echeance task={tache} /> : t("Aucune")}
                  </td>
                  <td className="whitespace-nowrap px-4 py-2.5 text-muted-foreground">
                    {projectName(tache.projectId) ?? t("Sans projet")}
                  </td>
                  <td className="whitespace-nowrap px-4 py-2.5 text-muted-foreground">{agentName(tache.agentId)}</td>
                  <td className="px-4 py-2.5 text-muted-foreground">{tache.toolLog?.length ?? 0}</td>
                  <td className="whitespace-nowrap px-4 py-2.5 text-muted-foreground">
                    {dateHeure(tache.updatedAt)}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function CalendarView({
  tasks,
  onOpen,
  onCreate,
  mode,
  onMode,
}: ViewProps & { mode: ModeCalendrier; onMode: (m: ModeCalendrier) => void }) {
  const { moisAnnee } = useFormats();
  // La période visible : ce qui rend « précédente » et « suivante » utiles.
  const [reference, setReference] = useState(() => new Date());
  const aujourdhui = aujourdhuiJour();
  const jours = mode === "semaine" ? joursSemaine(reference) : joursMois(reference);

  // Les tâches arrivent triées : chaque case garde cet ordre.
  const parJour = useMemo(() => {
    const index = new Map<string, Task[]>();
    for (const t of tasks) {
      const jour = echeanceDe(t);
      if (!jour) continue;
      index.set(jour, [...(index.get(jour) ?? []), t]);
    }
    return index;
  }, [tasks]);
  const sansEcheance = tasks.filter((t) => !echeanceDe(t)).length;

  const avancer = (sensDeplacement: 1 | -1) =>
    setReference((r) =>
      mode === "semaine"
        ? decaler(r, 7 * sensDeplacement)
        : new Date(r.getFullYear(), r.getMonth() + sensDeplacement, 1),
    );

  return (
    <div className="flex h-full flex-col px-6 py-5">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Button variant="secondary" size="sm" onClick={() => setReference(new Date())}>
            {t("Aujourd'hui")}
          </Button>
          <IconButton
            icon={ChevronLeft}
            label={mode === "semaine" ? t("Semaine précédente") : t("Mois précédent")}
            size={30}
            iconSize={16}
            onClick={() => avancer(-1)}
          />
          <IconButton
            icon={ChevronRight}
            label={mode === "semaine" ? t("Semaine suivante") : t("Mois suivant")}
            size={30}
            iconSize={16}
            onClick={() => avancer(1)}
          />
          <span className="ms-1 text-sm font-semibold capitalize text-foreground">
            {moisAnnee(reference)}
          </span>
        </div>
        <SegmentedTabs
          size="sm"
          options={[
            { id: "semaine", label: t("Semaine") },
            { id: "mois", label: t("Mois") },
          ]}
          value={mode}
          onChange={(m) => onMode(m as ModeCalendrier)}
        />
      </div>

      {/*
        Une tâche sans échéance n'a pas de case. On dit combien la vue en
        écarte, plutôt que de laisser croire que le filtre les a perdues.
      */}
      {sansEcheance > 0 && (
        <p className="mb-2 text-xs text-muted-foreground">
          {sansEcheance === 1
            ? t("1 tâche sans échéance ne figure pas dans le calendrier.")
            : tf("{0} tâches sans échéance ne figurent pas dans le calendrier.", sansEcheance)}
        </p>
      )}

      <div className="grid grid-cols-7 rounded-t-xl border border-b-0 border-border">
        {nomsDesJours("short").map((n, i) => (
          <span
            key={i}
            className={cn(
              "py-2 text-center text-[11px] font-medium uppercase tracking-wide text-muted-foreground",
              i < 6 && "border-e border-border",
            )}
          >
            {n}
          </span>
        ))}
      </div>
      <div
        className={cn(
          "grid flex-1 grid-cols-7 overflow-hidden rounded-b-xl border border-border",
          mode === "mois" && "auto-rows-fr",
        )}
      >
        {jours.map((d, i) => {
          const jour = jourDe(d);
          const items = parJour.get(jour) ?? [];
          const estAujourdhui = jour === aujourdhui;
          const horsMois = mode === "mois" && d.getMonth() !== reference.getMonth();
          return (
            <div
              key={jour}
              className={cn(
                "group flex min-h-0 flex-col border-border",
                i % 7 < 6 && "border-e",
                i < jours.length - 7 && "border-b",
                estAujourdhui && "bg-muted/40",
                mode === "mois" ? "min-h-[96px]" : "min-h-[200px]",
              )}
            >
              <div className="flex items-center justify-between px-1.5 pt-1.5">
                <span
                  className={cn(
                    "flex h-7 w-7 items-center justify-center rounded-full text-sm font-medium",
                    estAujourdhui
                      ? "bg-primary text-primary-foreground"
                      : horsMois
                        ? "text-muted-foreground/60"
                        : "text-foreground",
                  )}
                >
                  {d.getDate()}
                </span>
                <IconButton
                  icon={Plus}
                  label={t("Ajouter une tâche ce jour-là")}
                  size={22}
                  iconSize={13}
                  className="opacity-0 focus:opacity-100 group-hover:opacity-100"
                  onClick={() => onCreate({ dueDate: jour })}
                />
              </div>
              <div className="min-h-0 flex-1 space-y-1 overflow-y-auto px-1.5 pb-1.5 pt-1">
                {items.map((t) => {
                  const s = situation(t, aujourdhui);
                  return (
                    <button
                      key={t.id}
                      type="button"
                      onClick={() => onOpen(t)}
                      title={s === "retard" ? `En retard : ${t.title}` : t.title}
                      className={cn(
                        "flex w-full items-center gap-1 truncate rounded-md border px-1.5 py-1 text-start text-[11px] transition-colors hover:bg-muted",
                        s === "retard"
                          ? "border-destructive/40 bg-destructive/[0.06] text-destructive"
                          : "border-border bg-card text-foreground",
                        (t.status === "terminee" || t.status === "annulee") &&
                          "text-muted-foreground line-through",
                      )}
                    >
                      {s === "retard" && (
                        <TriangleAlert size={10} strokeWidth={2} className="shrink-0" />
                      )}
                      <span className="truncate">{t.title}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ========================================================================== */
/* Page                                                                        */
/* ========================================================================== */

function TaskField({
  icon: Icon,
  label,
  children,
}: {
  icon: typeof User;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-3 py-1.5 text-sm">
      <span className="flex w-32 shrink-0 items-center gap-2 text-muted-foreground">
        <Icon size={15} strokeWidth={1.75} />
        {label}
      </span>
      <span className="flex min-w-0 flex-1 items-center gap-1.5 text-foreground">{children}</span>
    </div>
  );
}

const SANS_PROJET = "";

export function TachesPage() {
  const moi = currentUser().id;
  /*
   * Les préférences sont tenues avec le compte auquel elles appartiennent.
   * Sans cela, un changement de compte pendant que l'écran reste monté (poste
   * partagé) faisait écrire les réglages de la personne précédente sous la clé
   * de la suivante : constaté en vérifiant le cloisonnement, la rubrique et le
   * tri d'Alice étaient apparus chez Bruno.
   */
  const [etat, setEtat] = useState(() => ({ compte: moi, prefs: lirePreferences(moi) }));
  const prefs = etat.compte === moi ? etat.prefs : lirePreferences(moi);
  const [query, setQuery] = useState("");
  const [modalOpen, setModalOpen] = useState(false);
  const [projetModal, setProjetModal] = useState(false);
  const [nomProjet, setNomProjet] = useState("");
  const [detail, setDetail] = useState<Task | null>(null);
  /** Le compte rendu de la tâche ouverte, en grand (28/09/2026). */
  const [compteRenduGrand, setCompteRenduGrand] = useState(false);
  useEffect(() => setCompteRenduGrand(false), [detail?.id]);
  const [filtreOuvert, setFiltreOuvert] = useState(false);
  const [triOuvert, setTriOuvert] = useState(false);

  const { tasks, create, update, remove, delegate, cancel, runningIds } = useTasks();
  const { selectable } = useAgents();
  const { projects, create: creerProjet } = useProjects();

  useEffect(() => {
    if (etat.compte !== moi) setEtat({ compte: moi, prefs: lirePreferences(moi) });
    // On n'écrit que des réglages sous la clé de leur propre compte.
    else ecrirePreferences(etat.compte, etat.prefs);
  }, [etat, moi]);
  const regler = (changements: Partial<Preferences>) =>
    setEtat((e) => ({
      compte: moi,
      prefs: { ...(e.compte === moi ? e.prefs : lirePreferences(moi)), ...changements },
    }));

  const [draftTitle, setDraftTitle] = useState("");
  const [draftDesc, setDraftDesc] = useState("");
  const [draftPriority, setDraftPriority] = useState<TaskPriority>("moyenne");
  const [draftAgent, setDraftAgent] = useState(DEFAULT_AGENT.id);
  /*
   * Colonne visée par la création. Le « + » de chaque colonne transmettait bien
   * son statut, mais le gestionnaire de la page le jetait : la carte partait
   * toujours dans « À faire », y compris quand on avait cliqué sur « Terminée ».
   */
  const [draftStatus, setDraftStatus] = useState<TaskStatus>("a-faire");
  const [draftDue, setDraftDue] = useState<string | null>(null);
  const [draftProject, setDraftProject] = useState<string>(SANS_PROJET);
  const [draftApres, setDraftApres] = useState<string[]>([]);
  const [draftAuto, setDraftAuto] = useState(true);

  /*
   * Une tâche dont l'agent a été supprimé est faite par l'agent par défaut
   * (`runTask`) : on le dit, plutôt que d'afficher « Agent par défaut » comme
   * si c'était le choix fait à sa création.
   */
  const agentName = (id?: string) =>
    selectable.find((a) => a.id === (id ?? DEFAULT_AGENT.id))?.name ??
    (id ? t("Agent par défaut (le sien a été supprimé)") : t("Agent par défaut"));

  // Seuls les projets que la personne voit ont un nom à l'écran.
  const projetsParId = useMemo(() => new Map(projects.map((p) => [p.id, p])), [projects]);
  const projectName = (id?: string) => (id ? (projetsParId.get(id)?.name ?? null) : null);

  /*
   * Rubrique effective. Un projet mémorisé qu'on ne voit plus retombe sur
   * « Mes tâches » sans effacer la préférence : au premier chargement, la
   * liste des projets peut arriver de l'instance un instant après la page.
   */
  const rubrique =
    prefs.rubrique.startsWith(PREFIXE_PROJET) &&
    !projetsParId.has(prefs.rubrique.slice(PREFIXE_PROJET.length))
      ? "mine"
      : prefs.rubrique;

  const ctx: Contexte = { moi, aujourdhui: aujourdhuiJour(), projets: new Set(projetsParId.keys()) };

  // Compteurs de la navigation : ce que contient chaque rubrique, sans filtre.
  const compteurs = new Map<string, number>();
  for (const id of [
    ...RUBRIQUES.map((r) => r.id as string),
    ...projects.map((p) => `${PREFIXE_PROJET}${p.id}`),
  ]) {
    compteurs.set(id, tasks.filter((t) => dansRubrique(t, id, ctx)).length);
  }

  const dansRubriqueCourante = tasks.filter((t) => dansRubrique(t, rubrique, ctx));

  /*
   * Chaîne complète, commune aux trois vues : rubrique, recherche, filtres
   * (statut, priorité, agent), puis tri. Le Kanban, le Tableau et le
   * Calendrier reçoivent la même liste ; ils ne font que la disposer.
   */
  const q = query.trim().toLowerCase();
  const visibles = trier(
    dansRubriqueCourante.filter(
      (t) =>
        (!q || t.title.toLowerCase().includes(q) || t.description.toLowerCase().includes(q)) &&
        (prefs.statuts.length === 0 || prefs.statuts.includes(t.status)) &&
        (prefs.priorites.length === 0 || prefs.priorites.includes(t.priority)) &&
        (prefs.agents.length === 0 || prefs.agents.includes(t.agentId ?? DEFAULT_AGENT.id)),
    ),
    prefs.tri,
    prefs.sens,
  );

  const enRetard =
    rubrique === "today" ? visibles.filter((t) => situation(t, ctx.aujourdhui) === "retard").length : 0;

  const nbFiltres = prefs.statuts.length + prefs.priorites.length + prefs.agents.length;
  const champTri = CHAMPS_TRI.find((c) => c.id === prefs.tri)!;

  const titreRubrique = rubrique.startsWith(PREFIXE_PROJET)
    ? (projectName(rubrique.slice(PREFIXE_PROJET.length)) ?? t("Projet"))
    : (RUBRIQUES.find((r) => r.id === rubrique)?.label ?? t("Mes tâches"));

  // La carte ouverte doit refléter les mises à jour de l'exécution.
  const liveDetail = detail ? (tasks.find((t) => t.id === detail.id) ?? detail) : null;

  const resetDraft = () => {
    setDraftTitle("");
    setDraftDesc("");
    setDraftPriority("moyenne");
    setDraftAgent(DEFAULT_AGENT.id);
    setDraftStatus("a-faire");
    setDraftDue(null);
    setDraftProject(SANS_PROJET);
    setDraftApres([]);
    setDraftAuto(true);
  };

  /**
   * Ouvre la modale de création, préremplie d'après l'endroit d'où l'on part :
   * une tâche créée depuis « Aujourd'hui » naît pour aujourd'hui, depuis un
   * projet dans ce projet. Sans cela, la carte qu'on vient de créer
   * disparaîtrait aussitôt de la vue qu'on regarde.
   */
  const ouvrirCreation = (init: { status?: TaskStatus; dueDate?: string } = {}) => {
    setDraftStatus(init.status ?? "a-faire");
    const aujourdhui = new Date();
    setDraftDue(
      init.dueDate ??
        (rubrique === "today"
          ? jourDe(aujourdhui)
          : rubrique === "upcoming"
            ? jourDe(decaler(aujourdhui, 1))
            : null),
    );
    setDraftProject(
      rubrique.startsWith(PREFIXE_PROJET) ? rubrique.slice(PREFIXE_PROJET.length) : SANS_PROJET,
    );
    setModalOpen(true);
  };

  const viewProps: ViewProps = {
    tasks: visibles,
    statuts: prefs.statuts,
    agentName,
    projectName,
    runningIds,
    toutes: tasks,
    onDelegate: (t) => void delegate(t),
    onCancel: cancel,
    onOpen: setDetail,
    onDelete: remove,
    onCreate: ouvrirCreation,
  };

  /** Clic sur un en-tête du tableau : même champ, on inverse le sens ; autre champ, on le prend. */
  const trierPar = (champ: ChampTri) =>
    regler(
      champ === prefs.tri
        ? { sens: prefs.sens === "asc" ? "desc" : "asc" }
        : { tri: champ, sens: champ === "echeance" ? "asc" : "desc" },
    );

  const optionsProjet = [
    { value: SANS_PROJET, label: t("Sans projet") },
    ...projects.map((p) => ({ value: p.id, label: p.name })),
  ];

  if (rubrique === RUBRIQUE_PROGRAMMEES) {
    return (
      <div className="flex h-full min-w-0 flex-col md:flex-row">
        <ProjectsPanel
          rubrique={rubrique}
          onRubrique={(id) => regler({ rubrique: id })}
          projets={projects}
          compteurs={compteurs}
          onNouveauProjet={() => setProjetModal(true)}
        />
        <TachesProgrammees />
      </div>
    );
  }

  return (
    <div className="flex h-full min-w-0 flex-col md:flex-row">
      <ProjectsPanel
        rubrique={rubrique}
        onRubrique={(id) => regler({ rubrique: id })}
        projets={projects}
        compteurs={compteurs}
        onNouveauProjet={() => setProjetModal(true)}
      />

      <section className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <div className="flex items-start justify-between gap-4 px-6 pb-3 pt-6">
          <div className="min-w-0">
            <h1 className="truncate text-xl font-semibold tracking-tight text-foreground">
              {titreRubrique}
            </h1>
            <p className="text-sm text-muted-foreground">
              {/* Une phrase par nombre (28/09/2026) : le « s » ajouté en français donnait « 3 项任务s », et « sur » restait en français. */}
              {visibles.length === 0
                ? t("Aucune tâche")
                : visibles.length !== dansRubriqueCourante.length
                  ? tf("{0} sur {1}", visibles.length === 1 ? t("1 tâche") : tf("{0} tâches", visibles.length), dansRubriqueCourante.length)
                  : visibles.length === 1
                    ? t("1 tâche")
                    : tf("{0} tâches", visibles.length)}
              {enRetard > 0 && (
                <span className="text-destructive">
                  {" "}
                  · {enRetard}{" "}{t("en retard")}
                </span>
              )}
            </p>
          </div>
          <Button icon={Plus} onClick={() => ouvrirCreation()}>
            {t("Nouvelle tâche")}
          </Button>
        </div>

        <div className="flex flex-wrap items-center gap-2 border-b border-border px-6 pb-3">
          <SegmentedTabs
            size="sm"
            options={viewTabs}
            value={prefs.vue}
            onChange={(v) => regler({ vue: v as Vue })}
          />
          <div className="flex min-w-[180px] flex-1 items-center gap-2 rounded-lg border border-border bg-card px-3 py-1.5 text-muted-foreground">
            <Search size={15} strokeWidth={1.75} />
            <input
              className="w-full bg-transparent text-sm text-foreground placeholder:text-muted-foreground focus:outline-none"
              placeholder={t("Rechercher une tâche...")}
              aria-label={t("Rechercher une tâche")}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>

          {/* Filtre : statut, priorité, agent. S'applique aux trois vues. */}
          <Popover
            open={filtreOuvert}
            onOpenChange={setFiltreOuvert}
            align="end"
            width={260}
            trigger={(p) => (
              <Button
                variant="secondary"
                size="sm"
                icon={Filter}
                onClick={p.onClick}
                aria-expanded={p["aria-expanded"]}
                className={cn(nbFiltres > 0 && "border-primary/40 text-foreground")}
              >
                {t("Filtre")}{nbFiltres > 0 ? ` (${nbFiltres})` : ""}
              </Button>
            )}
          >
            <div className="max-h-[420px] overflow-y-auto">
              <p className="px-2.5 pb-1 pt-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                {t("Statut")}
              </p>
              {STATUSES.map((s) => (
                <CaseFiltre
                  key={s.id}
                  coche={prefs.statuts.includes(s.id)}
                  onClick={() => regler({ statuts: basculer(prefs.statuts, s.id) })}
                >
                  {s.label}
                </CaseFiltre>
              ))}
              <p className="px-2.5 pb-1 pt-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                {t("Priorité")}
              </p>
              {PRIORITES.map((p) => (
                <CaseFiltre
                  key={p.id}
                  coche={prefs.priorites.includes(p.id)}
                  onClick={() => regler({ priorites: basculer(prefs.priorites, p.id) })}
                >
                  {p.label}
                </CaseFiltre>
              ))}
              <p className="px-2.5 pb-1 pt-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                {t("Agent")}
              </p>
              {selectable.map((a) => (
                <CaseFiltre
                  key={a.id}
                  coche={prefs.agents.includes(a.id)}
                  onClick={() => regler({ agents: basculer(prefs.agents, a.id) })}
                >
                  {a.name}
                </CaseFiltre>
              ))}
            </div>
            <div className="my-1 h-px bg-border" />
            <button
              type="button"
              disabled={nbFiltres === 0}
              onClick={() => regler({ statuts: [], priorites: [], agents: [] })}
              className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:bg-transparent"
            >
              <X size={15} strokeWidth={1.75} />
              {t("Effacer les filtres")}
            </button>
          </Popover>

          {/* Tri : champ et sens. S'applique aux trois vues. */}
          <Popover
            open={triOuvert}
            onOpenChange={setTriOuvert}
            align="end"
            width={280}
            trigger={(p) => (
              <Button
                variant="secondary"
                size="sm"
                icon={ArrowUpDown}
                onClick={p.onClick}
                aria-expanded={p["aria-expanded"]}
              >
                {t("Tri :")}{" "}{champTri.label.toLowerCase()} {prefs.sens === "asc" ? "↑" : "↓"}
              </Button>
            )}
          >
            <p className="px-2.5 pb-1 pt-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {t("Trier par")}
            </p>
            {CHAMPS_TRI.map((c) => (
              <button
                key={c.id}
                type="button"
                role="menuitemradio"
                aria-checked={prefs.tri === c.id}
                onClick={() => regler({ tri: c.id })}
                className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-start text-sm text-foreground transition-colors hover:bg-muted"
              >
                <span className="flex-1">{c.label}</span>
                {prefs.tri === c.id && <Check size={15} strokeWidth={2} />}
              </button>
            ))}
            <p className="px-2.5 pb-1 pt-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {t("Sens")}
            </p>
            {(["asc", "desc"] as const).map((s) => (
              <button
                key={s}
                type="button"
                role="menuitemradio"
                aria-checked={prefs.sens === s}
                onClick={() => regler({ sens: s })}
                className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-start text-sm text-foreground transition-colors hover:bg-muted"
              >
                {s === "asc" ? (
                  <ArrowUp size={15} strokeWidth={1.75} />
                ) : (
                  <ArrowDown size={15} strokeWidth={1.75} />
                )}
                <span className="flex-1">
                  {s === "asc" ? t("Croissant") : t("Décroissant")}
                  <span className="block text-xs text-muted-foreground">
                    {s === "asc" ? champTri.asc : champTri.desc}
                  </span>
                </span>
                {prefs.sens === s && <Check size={15} strokeWidth={2} />}
              </button>
            ))}
            {prefs.tri === "echeance" && (
              <p className="px-2.5 pb-1 pt-2 text-xs text-muted-foreground">
                {t("Les tâches sans échéance restent en fin de liste.")}
              </p>
            )}
          </Popover>
        </div>

        <div className="min-h-0 flex-1 overflow-auto">
          {prefs.vue === "kanban" && <KanbanView {...viewProps} />}
          {prefs.vue === "tableau" && (
            <TableView {...viewProps} tri={prefs.tri} sens={prefs.sens} onTri={trierPar} />
          )}
          {prefs.vue === "calendrier" && (
            <CalendarView
              {...viewProps}
              mode={prefs.modeCalendrier}
              onMode={(m) => regler({ modeCalendrier: m })}
            />
          )}
        </div>
      </section>

      {/* Modale nouveau projet, depuis le panneau de gauche. */}
      <Modal
        open={projetModal}
        onClose={() => {
          setNomProjet("");
          setProjetModal(false);
        }}
        size="sm"
      >
        <h2 className="text-lg font-semibold text-foreground">{t("Nouveau projet")}</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {t("Vous pourrez inviter des membres depuis l'écran Projets. Vos tâches y resteront personnelles.")}
        </p>
        <Input
          className="mt-4"
          placeholder={t("Nom du projet")}
          aria-label={t("Nom du projet")}
          value={nomProjet}
          onChange={(e) => setNomProjet(e.target.value)}
          autoFocus
        />
        <div className="mt-5 flex justify-end gap-2">
          <Button
            variant="secondary"
            onClick={() => {
              setNomProjet("");
              setProjetModal(false);
            }}
          >
            {t("Annuler")}
          </Button>
          <Button
            disabled={!nomProjet.trim()}
            onClick={() => {
              const projet = creerProjet(nomProjet);
              setNomProjet("");
              setProjetModal(false);
              regler({ rubrique: `${PREFIXE_PROJET}${projet.id}` });
            }}
          >
            {t("Créer le projet")}
          </Button>
        </div>
      </Modal>

      {/*
        Modale nouvelle tâche. Les boutons Partager, Favori et Options qui
        surmontaient ce formulaire ont été retirés : une tâche ne se partage
        pas (la passerelle ne la montre qu'à son propriétaire), aucun modèle ne
        porte de favori, et le menu d'options ne contenait rien.
      */}
      <Modal
        open={modalOpen}
        onClose={() => {
          resetDraft();
          setModalOpen(false);
        }}
      >
        <input
          className="w-full bg-transparent pe-8 text-xl font-semibold text-foreground placeholder:text-muted-foreground/70 focus:outline-none"
          placeholder={t("Entrez le titre de la tâche...")}
          aria-label={t("Titre de la tâche")}
          value={draftTitle}
          onChange={(e) => setDraftTitle(e.target.value)}
          autoFocus
        />
        <textarea
          rows={3}
          className="mt-2 w-full resize-none bg-transparent text-sm text-muted-foreground placeholder:text-muted-foreground focus:outline-none"
          placeholder={t("Appuyez sur Entrée pour commencer à écrire, ou collez du contenu...")}
          aria-label={t("Description de la tâche")}
          value={draftDesc}
          onChange={(e) => setDraftDesc(e.target.value)}
        />

        <div className="mt-2 space-y-0.5 border-t border-border pt-4">
          <TaskField icon={Bot} label={t("Agent")}>
            <Select
              className="w-full"
              value={draftAgent}
              onChange={setDraftAgent}
              options={selectable.map((a) => ({ value: a.id, label: a.name }))}
            />
          </TaskField>
          {/*
            La colonne d'arrivée se voit et se corrige avant de valider : le
            « + » d'une colonne la préremplit, mais rien n'obligeait jusqu'ici
            à faire confiance à un choix invisible.
          */}
          <TaskField icon={Circle} label={t("Colonne")}>
            <Select
              className="w-full"
              value={draftStatus}
              onChange={(v) => setDraftStatus(v as TaskStatus)}
              options={STATUSES.map((s) => ({ value: s.id, label: s.label }))}
            />
          </TaskField>
          <TaskField icon={Flag} label={t("Priorité")}>
            <Select
              className="w-full"
              value={draftPriority}
              onChange={(v) => setDraftPriority(v as TaskPriority)}
              options={[
                { value: "basse", label: t("Basse") },
                { value: "moyenne", label: t("Moyenne") },
                { value: "haute", label: t("Haute") },
              ]}
            />
          </TaskField>
          {features.projets && (
            <TaskField icon={FolderKanban} label={t("Projet")}>
              <Select
                className="w-full"
                value={draftProject}
                onChange={setDraftProject}
                options={optionsProjet}
              />
            </TaskField>
          )}
          <TaskField icon={CalendarIcon} label={t("Date d'échéance")}>
            <ChampEcheance valeur={draftDue} onChange={setDraftDue} />
          </TaskField>
          <TaskField icon={Link2} label={t("Après")}>
            <ChoixPrerequis valeur={draftApres} onChange={setDraftApres} taches={tasks} />
          </TaskField>
          {draftApres.length > 0 && (
            <TaskField icon={Play} label={t("Lancement")}>
              <span className="flex min-w-0 flex-1 items-center justify-between gap-3">
                <span className="text-muted-foreground">{libelleLancement(draftAuto, draftApres.length)}</span>
                <Switch checked={draftAuto} onChange={setDraftAuto} label={t("Lancer d'elle-même après les tâches choisies")} />
              </span>
            </TaskField>
          )}
        </div>
        {draftApres.length > 0 && (
          <p className="mt-2 text-xs text-muted-foreground">
            {t("Son agent recevra le compte rendu")}{" "}{draftApres.length > 1 ? t("des tâches choisies") : t("de la tâche choisie")}{t(", pour s'appuyer dessus.")}
          </p>
        )}

        <div className="mt-6 flex justify-end gap-2">
          <Button
            variant="secondary"
            onClick={() => {
              resetDraft();
              setModalOpen(false);
            }}
          >
            {t("Annuler")}
          </Button>
          <Button
            disabled={!draftTitle.trim()}
            onClick={() => {
              create({
                title: draftTitle,
                description: draftDesc,
                priority: draftPriority,
                agentId: draftAgent,
                status: draftStatus,
                dueDate: draftDue ?? undefined,
                projectId: draftProject || undefined,
                dependsOn: draftApres,
                autoStart: draftAuto,
              });
              resetDraft();
              setModalOpen(false);
            }}
          >
            {t("Créer")}
          </Button>
        </div>
      </Modal>

      {/* Détail d'une tâche : réglages modifiables et compte rendu de l'agent */}
      <Modal open={Boolean(liveDetail)} onClose={() => setDetail(null)} size="lg">
        {liveDetail && (
          <>
            <h2 className="pe-8 text-lg font-semibold text-foreground">{liveDetail.title}</h2>
            <div className="mt-1 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
              <span className="inline-flex items-center gap-1">
                <Bot size={13} strokeWidth={2} /> {agentName(liveDetail.agentId)}
              </span>
              {situation(liveDetail, aujourdhuiJour()) === "retard" && (
                <>
                  <span>·</span>
                  <Echeance task={liveDetail} />
                </>
              )}
              {runningIds.includes(liveDetail.id) && (
                <>
                  <span>·</span>
                  <span className="inline-flex items-center gap-1.5 text-warning">
                    <Loader2 size={13} className="animate-spin" />{" "}{t("en cours")}
                  </span>
                </>
              )}
            </div>

            {liveDetail.description && (
              <p className="mt-3 whitespace-pre-wrap text-sm text-muted-foreground">
                {liveDetail.description}
              </p>
            )}

            {/*
              Classer et dater une tâche existante : sans cela, une tâche créée
              sans projet ni échéance resterait dans la boîte de réception pour
              toujours.
            */}
            <div className="mt-4 space-y-0.5 border-t border-border pt-3">
              <TaskField icon={Circle} label={t("Statut")}>
                <Select
                  className="w-full"
                  value={liveDetail.status}
                  onChange={(v) => update(liveDetail.id, { status: v as TaskStatus })}
                  options={STATUSES.map((s) => ({ value: s.id, label: s.label }))}
                />
              </TaskField>
              <TaskField icon={Flag} label={t("Priorité")}>
                <Select
                  className="w-full"
                  value={liveDetail.priority}
                  onChange={(v) => update(liveDetail.id, { priority: v as TaskPriority })}
                  options={[
                    { value: "basse", label: t("Basse") },
                    { value: "moyenne", label: t("Moyenne") },
                    { value: "haute", label: t("Haute") },
                  ]}
                />
              </TaskField>
              {features.projets && (
                <TaskField icon={FolderKanban} label={t("Projet")}>
                  <Select
                    className="w-full"
                    value={
                      liveDetail.projectId && projetsParId.has(liveDetail.projectId)
                        ? liveDetail.projectId
                        : SANS_PROJET
                    }
                    onChange={(v) => update(liveDetail.id, { projectId: v || undefined })}
                    options={optionsProjet}
                  />
                </TaskField>
              )}
              <TaskField icon={CalendarIcon} label={t("Date d'échéance")}>
                <ChampEcheance
                  valeur={echeanceDe(liveDetail)}
                  onChange={(jour) => update(liveDetail.id, { dueDate: jour ?? undefined })}
                />
              </TaskField>
              <TaskField icon={Link2} label={t("Après")}>
                <ChoixPrerequis
                  tacheId={liveDetail.id}
                  valeur={liveDetail.dependsOn ?? []}
                  onChange={(ids) =>
                    update(liveDetail.id, {
                      dependsOn: ids,
                      // Première dépendance choisie : lancement automatique par défaut, comme à la création.
                      autoStart: ids.length > 0 ? (liveDetail.dependsOn?.length ? liveDetail.autoStart : true) : undefined,
                    })
                  }
                  taches={tasks}
                />
              </TaskField>
              {(liveDetail.dependsOn?.length ?? 0) > 0 && (
                <TaskField icon={Play} label={t("Lancement")}>
                  <span className="flex min-w-0 flex-1 items-center justify-between gap-3">
                    <span className="text-muted-foreground">
                      {libelleLancement(Boolean(liveDetail.autoStart), liveDetail.dependsOn?.length ?? 0)}
                    </span>
                    <Switch
                      checked={Boolean(liveDetail.autoStart)}
                      onChange={(v) => update(liveDetail.id, { autoStart: v })}
                      label={t("Lancer d'elle-même après les tâches choisies")}
                    />
                  </span>
                </TaskField>
              )}
            </div>

            {(() => {
              const attente = liveDetail.status === "a-faire" ? attenteDe(etatPrerequis(liveDetail, tasks)) : null;
              const suites = suitesDe(liveDetail.id, tasks);
              if (!attente && suites.length === 0) return null;
              return (
                <div className="mt-3 space-y-1 text-xs text-muted-foreground">
                  {attente && <p>{attente}{t(". Son agent recevra le compte rendu de ce qui la précède.")}</p>}
                  {suites.length > 0 && (
                    <p>
                      {t("Attendue par")}{" "}{lister(suites.map((t) => `« ${t.title} »`))}
                      {(() => {
                        const partiront = suites.filter((t) => t.autoStart && t.status === "a-faire").length;
                        if (partiront === 0) return ".";
                        if (suites.length === 1) return t(" : elle partira quand celle-ci sera terminée.");
                        return partiront === suites.length
                          ? t(" : elles partiront quand celle-ci sera terminée.")
                          : tf(" : {0} partiront d'elles-mêmes quand celle-ci sera terminée.", partiront);
                      })()}
                    </p>
                  )}
                </div>
              );
            })()}

            {liveDetail.toolLog && liveDetail.toolLog.length > 0 && (
              <div className="mt-4">
                <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  {t("Outils utilisés")}
                </p>
                <ul className="space-y-1">
                  {liveDetail.toolLog.map((t, i) => (
                    <li
                      key={`${t.name}-${i}`}
                      className="flex items-start gap-2 rounded-lg bg-muted/50 px-2.5 py-1.5 text-xs"
                    >
                      <Wrench
                        size={12}
                        strokeWidth={2}
                        className={cn("mt-0.5 shrink-0", t.ok ? "text-success" : "text-destructive")}
                      />
                      <span className="min-w-0">
                        <span className="font-medium text-foreground">
                          {libelleOutil(t.name)}
                        </span>
                        {t.detail && (
                          <span className="block truncate text-muted-foreground">{t.detail}</span>
                        )}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {liveDetail.error && (
              <p className="mt-4 rounded-lg border border-destructive/30 bg-destructive/[0.06] px-3 py-2 text-sm text-foreground">
                {liveDetail.error}
              </p>
            )}

            {liveDetail.result && (
              <div className="mt-4">
                <div className="mb-1.5 flex items-center justify-between gap-2">
                  <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    {t("Compte rendu")}
                  </p>
                  <ActionsCompteRendu titre={liveDetail.title} texte={liveDetail.result} onAgrandir={() => setCompteRenduGrand(true)} />
                </div>
                <div className="max-h-64 overflow-y-auto rounded-xl bg-muted/40 p-3.5 text-sm text-foreground">
                  <TexteRiche texte={liveDetail.result} />
                </div>
                <Modal open={compteRenduGrand} onClose={() => setCompteRenduGrand(false)} size="xl">
                  <div className="flex items-start justify-between gap-4 pe-10">
                    <div className="min-w-0">
                      <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t("Compte rendu")}</p>
                      <h2 className="mt-1 text-lg font-semibold text-foreground">{liveDetail.title}</h2>
                    </div>
                    <ActionsCompteRendu titre={liveDetail.title} texte={liveDetail.result} />
                  </div>
                  <div className="mt-4 max-h-[70vh] overflow-y-auto text-[15px] leading-relaxed text-foreground">
                    <TexteRiche texte={liveDetail.result} />
                  </div>
                </Modal>
              </div>
            )}

            <div className="mt-6 flex justify-end gap-2">
              <Button variant="secondary" onClick={() => setDetail(null)}>
                {t("Fermer")}
              </Button>
              {runningIds.includes(liveDetail.id) ? (
                <Button icon={Square} onClick={() => cancel(liveDetail.id)}>
                  {t("Interrompre")}
                </Button>
              ) : (
                <Button
                  icon={Play}
                  disabled={!etatPrerequis(liveDetail, tasks).pret}
                  onClick={() => void delegate(liveDetail)}
                >
                  {liveDetail.status === "terminee" ? "Relancer" : t("Déléguer à l'agent")}
                </Button>
              )}
            </div>
          </>
        )}
      </Modal>
    </div>
  );
}

export default TachesPage;
