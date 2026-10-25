import { useMemo, useRef, useState } from "react";
import { Eye, EyeOff, BookOpenText, Bot, Loader2, Plus, RefreshCw, Paperclip, Sparkles, Trash2, TriangleAlert, Wrench, X } from "lucide-react";
import { PageHeader } from "@/components/layout/PageHeader";
import { Button } from "@/components/ui/Button";
import { SearchInput } from "@/components/ui/SearchInput";
import { SegmentedTabs } from "@/components/ui/SegmentedTabs";
import { EmptyState } from "@/components/ui/EmptyState";
import { Modal } from "@/components/ui/Modal";
import { Field, Input, Textarea } from "@/components/ui/Field";
import { Switch } from "@/components/ui/Switch";
import { branding } from "@/config/branding";
import { useAgents } from "@/hooks/useAgents";
import { useMiseEnService, type EtatMiseEnService } from "@/hooks/useMiseEnService";
import { currentUser } from "@/lib/store/identity";
import { getAgent, type Agent, type AgentVisibility } from "@/lib/store/agents";
import { AvatarAgent, ChoixPhotoAgent } from "@/components/ui/AvatarAgent";
import { ChoixModele, MiseAJourOpenClaw, ModeleDiscret, PanneauEmploye, Statut, useEmployes } from "@/components/agents/Employes";
import { ACCEPT_DOCUMENTS, proposerModele, retenirFichiers, supprimerEmploye, type Employe, type EtatEmployes } from "@/lib/employes";
import { optimiserInstructions } from "@/lib/gateway";
import { ChoixDepuisEspace } from "@/components/agents/ChoixDepuisEspace";
import { ChoixBases } from "@/components/bibliotheque/ChoixBases";
import { LectureBases } from "@/components/agents/LectureBases";
import { ChoixVisibilite } from "@/pages/BibliothequePage";
import { useGroupes, type Groupe } from "@/lib/groupes";
import { features } from "@/config/branding";
import { t, tf, lister } from "@/lib/i18n";

/**
 * Page Agents + modale de création (captures 12 à 14).
 *
 * Un seul geste : créer un agent. Il est mis en service tout seul sur
 * l'instance (OpenClaw s'installe s'il manque) et devient un membre de
 * l'équipe toujours actif : on lui parle depuis sa fiche, on lui confie des
 * missions, on le joint sur une messagerie. Dans le Chat, on peut aussi le
 * choisir comme avant.
 */
export function AgentsPage() {
  const { agents, create, update, remove } = useAgents();
  const [tab, setTab] = useState("tous");
  const [query, setQuery] = useState("");
  const [modalOpen, setModalOpen] = useState(false);
  const [ouvert, setOuvert] = useState<string | null>(null);
  const { etat, recharger } = useEmployes();

  const me = currentUser();
  const { etats, reessayer } = useMiseEnService(agents, me.id, etat, recharger);

  const employeDe = (agentId: string) => etat?.employes.find((e) => e.agentId === agentId);
  // Employés déployés avant que la création d'un agent ne s'en charge : ils restent visibles.
  const sansAgent = (etat?.employes ?? []).filter((e) => !e.agentId || !agents.some((a) => a.id === e.agentId));

  // Un employé sans agent se range selon sa propre visibilité (absente : organisation).
  const ongletDe = (v: string | undefined) => (v === "personnel" ? "personnels" : v === "groupes" ? "groupes" : "organisation");
  const counts = useMemo(
    () => ({
      tous: agents.length + sansAgent.length,
      organisation: agents.filter((a) => a.visibility === "organisation").length + sansAgent.filter((e) => ongletDe(e.visibilite) === "organisation").length,
      groupes: agents.filter((a) => a.visibility === "groupes").length + sansAgent.filter((e) => ongletDe(e.visibilite) === "groupes").length,
      personnels: agents.filter((a) => a.visibility === "personnel").length + sansAgent.filter((e) => ongletDe(e.visibilite) === "personnels").length,
    }),
    [agents, sansAgent],
  );

  const q = query.trim().toLowerCase();
  const filtered = useMemo(() => {
    const byTab = agents.filter((a) =>
      tab === "tous"
        ? true
        : tab === "organisation"
          ? a.visibility === "organisation"
          : tab === "groupes"
            ? a.visibility === "groupes"
            : a.visibility === "personnel",
    );
    return q
      ? byTab.filter((a) => a.name.toLowerCase().includes(q) || a.description.toLowerCase().includes(q))
      : byTab;
  }, [agents, tab, q]);
  const autres = sansAgent.filter((e) => (tab === "tous" || ongletDe(e.visibilite) === tab) && (!q || e.nom.toLowerCase().includes(q)));
  const { etat: etatGroupes } = useGroupes();
  const tousLesGroupes = etatGroupes?.groupes ?? [];

  const tabs = [
    { id: "tous", label: tf("Tous ({0})", counts.tous) },
    { id: "organisation", label: tf("Organisation ({0})", counts.organisation) },
    { id: "groupes", label: tf("Groupes ({0})", counts.groupes) },
    { id: "personnels", label: tf("Personnels ({0})", counts.personnels) },
  ];
  const panneau = etat?.employes.find((e) => e.id === ouvert) ?? null;
  const installation = etat?.moteur.installation;

  return (
    <div className="flex h-full flex-col overflow-y-auto px-8 py-7">
      <PageHeader
        showBack
        icon={Bot}
        title={t("Agents IA")}
        subtitle={t("Vos agents travaillent pour l'équipe, même quand personne ne leur parle")}
        actions={
          <>
            <SearchInput
              placeholder={t("Rechercher des agents...")}
              aria-label={t("Rechercher des agents")}
              containerClassName="w-[260px]"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <Button icon={Plus} onClick={() => setModalOpen(true)}>
              {t("Créer un agent")}
            </Button>
          </>
        }
      />

      {/* Les onglets défilent seuls à 375 pixels (28/09/2026) : ils faisaient défiler toute la page de côté. */}
      <div className="mt-6 max-w-full overflow-x-auto">
        <SegmentedTabs options={tabs} value={tab} onChange={setTab} />
      </div>

      {etat?.moteur.installe && <MiseAJourOpenClaw etat={etat} recharger={recharger} />}

      {!etat?.moteur.installe && (installation?.etape === "node" || installation?.etape === "openclaw") && (
        <p className="mt-4 flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 size={15} strokeWidth={1.75} className="animate-spin" />
          {tf("Première mise en service : {0} installe ce qu'il faut à vos agents. C'est une fois pour toutes, et quelques minutes.", branding.name)}
        </p>
      )}

      {filtered.length === 0 && autres.length === 0 ? (
        <EmptyState
          icon={Bot}
          title={agents.length === 0 ? t("Aucun agent IA") : t("Aucun résultat")}
          description={
            agents.length === 0
              ? t("Créez votre premier agent : il sera prêt à travailler dès sa création.")
              : t("Aucun agent ne correspond à votre recherche")
          }
        />
      ) : (
        <ul className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {filtered.map((agent) => (
            <AgentCard
              key={agent.id}
              agent={agent}
              employe={employeDe(agent.id)}
              etat={etat}
              groupes={tousLesGroupes}
              miseEnService={etats[agent.id]}
              canDelete={agent.ownerId === me.id}
              onOuvrir={(id) => setOuvert(id)}
              onReessayer={() => reessayer(agent.id)}
              onChoisirModele={(uid) => {
                update(agent.id, { modeleEmploye: uid });
                reessayer(agent.id);
              }}
              onConnaissances={(ids) => update(agent.id, { connaissances: ids })}
              onPhoto={(photo) => update(agent.id, { photo: photo ?? undefined })}
              onMasquer={(masquer) => update(agent.id, { hidePrompt: masquer })}
              onDelete={async () => {
                /*
                 * L'agent toujours actif d'abord, et son échec dit (29/09/2026, vu par
                 * Medhi) : l'erreur était avalée, la carte disparaissait quand même, et
                 * l'agent restait dans l'instance, revenu ensuite sans bouton pour le
                 * retirer. On ne retire la fiche que s'il n'y a plus rien derrière.
                 */
                const e = employeDe(agent.id);
                if (e && e.estProprietaire) await supprimerEmploye(e.id);
                remove(agent.id);
                await recharger();
              }}
            />
          ))}
          {autres.map((e) => (
            <CarteEmploye key={e.id} employe={e} etat={etat} groupes={tousLesGroupes} onOuvrir={() => setOuvert(e.id)} />
          ))}
        </ul>
      )}

      <AgentModal
        open={modalOpen}
        etat={etat}
        onClose={() => setModalOpen(false)}
        onCreate={(data, fichiers) => {
          // La mise en service suit d'elle-même (useMiseEnService), documents compris.
          const agent = create(data);
          retenirFichiers(agent.id, fichiers);
          setModalOpen(false);
        }}
      />

      {panneau && etat && (
        <PanneauEmploye
          employe={panneau}
          etat={etat}
          onFermer={() => setOuvert(null)}
          onChange={recharger}
          onRetire={() => {
            if (panneau.agentId) remove(panneau.agentId);
            // Le panneau d'un agent retiré ne reste pas ouvert sur lui.
            setOuvert(null);
            void recharger();
          }}
        />
      )}
    </div>
  );
}

/** « Personnel », « Organisation », ou « Groupes : Compta, RH » (un groupe supprimé est dit tel). */
function libelleVisibilite(visibilite: AgentVisibility | undefined, ids: string[] | undefined, groupes: Groupe[]): string {
  if (visibilite === "personnel") return t("Personnel");
  if (visibilite === "groupes") {
    const noms = (ids ?? []).map((id) => groupes.find((g) => g.id === id)?.nom ?? t("Groupe supprimé"));
    return noms.length > 0 ? tf("Groupes : {0}", lister(noms)) : t("Groupes");
  }
  return t("Organisation");
}

/** Ce que la carte dit de l'agent en service : l'état, ou l'étape de sa mise en service. */
function LigneService({
  employe,
  etat,
  miseEnService,
  onReessayer,
}: {
  employe?: Employe;
  etat: EtatEmployes | null;
  miseEnService?: EtatMiseEnService;
  onReessayer: () => void;
}) {
  if (miseEnService?.etape === "erreur") {
    const sansReessai = Boolean(miseEnService.modeleIndisponible);
    return (
      <span className="flex items-start gap-1.5 text-xs text-muted-foreground">
        <TriangleAlert size={13} strokeWidth={1.75} className="mt-0.5 shrink-0 text-warning" />
        <span className="min-w-0">
          {t("Pas encore en service :")}{" "}{miseEnService.message}{" "}
          {!sansReessai && (
            <button type="button" onClick={onReessayer} className="inline-flex items-center gap-1 underline underline-offset-2">
              <RefreshCw size={11} strokeWidth={2} />{" "}{t("Réessayer")}
            </button>
          )}
        </span>
      </span>
    );
  }
  if (miseEnService) {
    return (
      <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Loader2 size={13} strokeWidth={1.75} className="animate-spin" /> {miseEnService.message}
      </span>
    );
  }
  if (employe && etat) return <Statut employe={employe} etat={etat} />;
  return null;
}

/** Un autre modèle pour un agent dont le modèle a disparu avant sa mise en service (28/09/2026). */
function AutreModele({ agent, etat, onChoisir }: { agent: Agent; etat: EtatEmployes; onChoisir: (uid: string) => void }) {
  const proposition = useMemo(
    () =>
      proposerModele(etat.modeles, {
        outils: (agent.toolsEnabled && etat.familles.some((f) => f.disponible)) || (agent.connaissances?.length ?? 0) > 0,
        longueurPoste: (agent.instructions.trim() || agent.description.trim()).length,
      }),
    [etat, agent],
  );
  const [choisi, setChoisi] = useState<string | null>(null);
  const valeur = choisi ?? proposition?.uid ?? "";
  return (
    <div className="space-y-2 rounded-xl border border-border p-3">
      <ChoixModele modeles={etat.modeles} valeur={valeur} onChange={setChoisi} proposition={proposition} />
      <Button size="sm" disabled={!valeur} onClick={() => onChoisir(valeur)}>
        {t("Mettre en service")}
      </Button>
    </div>
  );
}

function AgentCard({
  agent,
  employe,
  etat,
  groupes,
  miseEnService,
  canDelete,
  onOuvrir,
  onReessayer,
  onChoisirModele,
  onConnaissances,
  onPhoto,
  onMasquer,
  onDelete,
}: {
  agent: Agent;
  employe?: Employe;
  etat: EtatEmployes | null;
  groupes: Groupe[];
  miseEnService?: EtatMiseEnService;
  canDelete: boolean;
  onOuvrir: (employeId: string) => void;
  onReessayer: () => void;
  /** Son modèle a disparu avant sa mise en service : un autre, choisi par la personne. */
  onChoisirModele: (uid: string) => void;
  onConnaissances: (ids: string[]) => void;
  /** Sa photo, changée par son propriétaire (null : retirée). */
  onPhoto: (photo: string | null) => void;
  /** Masquer ou montrer ses instructions à celles et ceux à qui il est partagé (son propriétaire). */
  onMasquer: (masquer: boolean) => void;
  onDelete: () => Promise<void>;
}) {
  const [confirmer, setConfirmer] = useState(false);
  const [retrait, setRetrait] = useState<{ occupe: boolean; erreur?: string }>({ occupe: false });
  const [bases, setBases] = useState<string[] | null>(null);
  const supprimer = async () => {
    setRetrait({ occupe: true });
    try {
      await onDelete();
    } catch (err) {
      setRetrait({ occupe: false, erreur: tf("Le retrait n'a pas abouti : {0}", err instanceof Error ? err.message : String(err)) });
      return;
    }
    setRetrait({ occupe: false });
    setConfirmer(false);
  };
  const nombreBases = agent.connaissances?.length ?? 0;
  return (
    <li className="group relative flex flex-col gap-2 rounded-2xl border border-border bg-card p-4 transition-shadow hover:shadow-sm">
      <button
        type="button"
        disabled={!employe}
        onClick={() => employe && onOuvrir(employe.id)}
        className="flex flex-1 flex-col gap-2 text-start disabled:cursor-default"
        aria-label={employe ? tf("Ouvrir {0}", agent.name) : undefined}
      >
        <div className="flex w-full items-start gap-3 pe-6">
          {/* La place de l'avatar : il est posé par-dessus, hors du bouton, pour que son propriétaire puisse y choisir une photo. */}
          <span className="h-10 w-10 shrink-0" aria-hidden />
          <div className="min-w-0 flex-1">
            <p className="truncate font-medium text-foreground">{agent.name}</p>
            <p className="truncate text-xs text-muted-foreground">
              {libelleVisibilite(agent.visibility, agent.groupIds, groupes)}
              {agent.visibility !== "personnel" && agent.hidePrompt && ` · ${t("instructions masquées")}`}
            </p>
          </div>
        </div>
        {agent.description && <p className="line-clamp-2 text-sm text-muted-foreground">{agent.description}</p>}
        <div className="mt-auto flex flex-wrap items-center gap-2">
          {miseEnService?.etape !== "erreur" && <LigneService employe={employe} etat={etat} miseEnService={miseEnService} onReessayer={onReessayer} />}
          {employe && !miseEnService && <ModeleDiscret employe={employe} />}
          {agent.toolsEnabled && (
            <span className="inline-flex w-fit items-center gap-1.5 rounded-full bg-accent/12 px-2 py-0.5 text-[11px] font-medium text-accent">
              <Wrench size={11} strokeWidth={2} />{" "}{t("Outils")}
            </span>
          )}
          {employe && (employe.canaux?.length ?? 0) > 0 && (
            <span className="text-[11px] text-muted-foreground">{t("Aussi sur")}{" "}{lister(employe.canaux?.map((c) => c.nom) ?? [])}</span>
          )}
        </div>
      </button>
      {/*
        * L'échec de la mise en service, hors du bouton de la carte (28/09/2026) :
        * son « Réessayer » y était un bouton dans un bouton. Et quand son
        * modèle a disparu, la personne en choisit un autre ici : l'instance
        * refuse le disparu sans en prendre un autre, et « Réessayer » seul le
        * redemandait sans fin.
        */}
      {miseEnService?.etape === "erreur" && (
        <div className="space-y-2">
          <LigneService employe={employe} etat={etat} miseEnService={miseEnService} onReessayer={onReessayer} />
          {miseEnService.modeleIndisponible && etat && canDelete && (
            <AutreModele agent={agent} etat={etat} onChoisir={onChoisirModele} />
          )}
        </div>
      )}
      <div className="absolute start-4 top-4">
        {canDelete ? <ChoixPhotoAgent photo={agent.photo} nom={agent.name} onChange={onPhoto} /> : <AvatarAgent photo={agent.photo} nom={agent.name} />}
      </div>
      {/*
        * Bases de connaissances de l'agent : son propriétaire les change ici.
        * Dans le Chat, chacun y lit ce qu'il a le droit de voir ; l'employé
        * toujours actif (OpenClaw) les consulte par un outil, avec ce qui est
        * ouvert à toute l'équipe, et aussi aux groupes de son propriétaire
        * quand rien de ce qui sort de lui ne va à quelqu'un d'autre
        * (useMiseEnService les lui recopie ; LectureBases dit ce qu'il lira).
        */}
      {features.bibliotheque && (canDelete || nombreBases > 0) && (
        <button
          type="button"
          disabled={!canDelete}
          onClick={() => setBases(agent.connaissances ?? [])}
          className="inline-flex w-fit items-center gap-1.5 rounded-full bg-info/10 px-2 py-0.5 text-[11px] font-medium text-info disabled:cursor-default"
        >
          <BookOpenText size={11} strokeWidth={2} />
          {nombreBases > 0 ? tf("{0} base(s) de connaissances", nombreBases) : t("Ajouter des connaissances")}
        </button>
      )}
      {/* Ses instructions, masquées ou non à ceux à qui il est partagé (27/09/2026) : son propriétaire bascule ici. */}
      {canDelete && agent.visibility !== "personnel" && (
        <button
          type="button"
          onClick={() => onMasquer(!agent.hidePrompt)}
          title={t("Masquées : l'instance ne les envoie pas aux postes de celles et ceux à qui il est partagé, et les ajoute elle-même au Chat.")}
          className="inline-flex w-fit items-center gap-1.5 rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground hover:text-foreground"
        >
          {agent.hidePrompt ? <EyeOff size={11} strokeWidth={2} /> : <Eye size={11} strokeWidth={2} />}
          {agent.hidePrompt ? t("Instructions masquées") : t("Masquer ses instructions")}
        </button>
      )}
      {bases && (
        <Modal open onClose={() => setBases(null)} size="md">
          <h2 className="pe-8 text-lg font-semibold text-foreground">{tf("Connaissances de {0}", agent.name)}</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {t("Dans le Chat, avec cet agent, les passages utiles de ces bases sont donnés au modèle avant chaque réponse, et cités sous la réponse. Chaque personne n'y lit que ce qu'elle a le droit de voir.")}
          </p>
          <div className="mt-4">
            <ChoixBases valeur={bases} onChange={setBases} />
          </div>
          <p className="mt-4 text-sm font-medium text-foreground">{t("Ce qu'il lit hors du Chat")}</p>
          <div className="mt-1">
            <LectureBases employe={employe} bases={bases} />
          </div>
          <div className="mt-5 flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setBases(null)}>
              {t("Annuler")}
            </Button>
            <Button
              onClick={() => {
                onConnaissances(bases);
                setBases(null);
              }}
            >
              {t("Enregistrer")}
            </Button>
          </div>
        </Modal>
      )}
      {canDelete &&
        (confirmer ? (
          <span className="absolute end-3 top-3 flex items-center gap-1 rounded-lg bg-card px-1 shadow-sm">
            <Button variant="destructive" size="sm" icon={retrait.occupe ? Loader2 : undefined} disabled={retrait.occupe} onClick={() => void supprimer()}>
              {retrait.occupe ? t("Retrait…") : t("Supprimer")}
            </Button>
            <Button variant="ghost" size="sm" disabled={retrait.occupe} onClick={() => { setConfirmer(false); setRetrait({ occupe: false }); }}>
              {t("Annuler")}
            </Button>
          </span>
        ) : (
          /*
           * Toujours visible, discrète (29/09/2026) : cachée tant que la souris ne
           * survolait pas la carte, la corbeille était introuvable au clavier, sur un
           * écran tactile, et pour qui ne savait pas qu'elle existait.
           */
          <button
            type="button"
            aria-label={tf("Supprimer {0}", agent.name)}
            title={tf("Supprimer {0}", agent.name)}
            onClick={() => setConfirmer(true)}
            className="absolute end-3 top-3 rounded p-1 text-muted-foreground/60 transition-colors hover:text-destructive focus-visible:text-destructive"
          >
            <Trash2 size={15} strokeWidth={1.75} />
          </button>
        ))}
      {retrait.erreur && (
        <p role="alert" className="flex items-start gap-1.5 text-xs text-destructive">
          <TriangleAlert size={13} strokeWidth={2} className="mt-0.5 shrink-0" />
          <span className="min-w-0">{retrait.erreur}</span>
        </p>
      )}
    </li>
  );
}

/** Employé déployé sans agent (avant que la création d'un agent ne s'en charge). */
function CarteEmploye({
  employe,
  etat,
  groupes,
  onOuvrir,
}: {
  employe: Employe;
  etat: EtatEmployes | null;
  groupes: Groupe[];
  onOuvrir: () => void;
}) {
  return (
    <li>
      <button
        type="button"
        onClick={onOuvrir}
        className="flex h-full w-full flex-col gap-2 rounded-2xl border border-border bg-card p-4 text-start transition-shadow hover:shadow-sm"
      >
        <div className="flex w-full items-start gap-3">
          <AvatarAgent photo={employe.agentId ? getAgent(employe.agentId)?.photo : undefined} nom={employe.nom} />
          <div className="min-w-0 flex-1">
            <p className="truncate font-medium text-foreground">{employe.nom}</p>
            <p className="text-xs text-muted-foreground">
              {/* Un employé personnel n'est vu que de son propriétaire : l'étiquette « Organisation » le disait ouvert à tous. */}
              {employe.visibilite === "personnel" || employe.visibilite === "groupes" ? (
                libelleVisibilite(employe.visibilite, employe.groupes, groupes)
              ) : (
                <>{t("Organisation · par")}{" "}{employe.proprietaire}</>
              )}
            </p>
          </div>
        </div>
        <p className="line-clamp-2 text-sm text-muted-foreground">{employe.poste}</p>
        <div className="mt-auto flex flex-wrap items-center gap-2">
          {etat && <Statut employe={employe} etat={etat} />}
          <ModeleDiscret employe={employe} />
        </div>
      </button>
    </li>
  );
}

interface NewAgent {
  photo?: string;
  name: string;
  description: string;
  instructions: string;
  visibility: AgentVisibility;
  groupIds: string[];
  hidePrompt: boolean;
  toolsEnabled: boolean;
  connaissances: string[];
  /** Le modèle de son employé toujours actif (27/09/2026). */
  modeleEmploye?: string;
}

function AgentModal({
  open,
  etat,
  onClose,
  onCreate,
}: {
  open: boolean;
  /** Les modèles que cette personne peut lui donner (null : l'instance n'a pas encore répondu). */
  etat: EtatEmployes | null;
  onClose: () => void;
  onCreate: (data: NewAgent, fichiers: File[]) => void;
}) {
  const [visibility, setVisibility] = useState<AgentVisibility>("personnel");
  const [groupIds, setGroupIds] = useState<string[]>([]);
  // Les groupes se choisissent comme dans la Bibliothèque : seulement les siens.
  const { etat: groupes } = useGroupes();
  const mesGroupes = (groupes?.groupes ?? []).filter((g) => g.estMembre);
  const [fichiers, setFichiers] = useState<File[]>([]);
  const [optimisation, setOptimisation] = useState(false);
  const [depuisEspace, setDepuisEspace] = useState(false);
  const [avantOptimisation, setAvantOptimisation] = useState<string | null>(null);
  const [erreurOptimisation, setErreurOptimisation] = useState<string | null>(null);
  const choixFichiers = useRef<HTMLInputElement>(null);
  const [hidePrompt, setHidePrompt] = useState(false);
  const [toolsEnabled, setToolsEnabled] = useState(true);
  const [connaissances, setConnaissances] = useState<string[]>([]);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [instructions, setInstructions] = useState("");
  const [photo, setPhoto] = useState<string | null>(null);
  /*
   * Son modèle (27/09/2026, demandé par Medhi : « pas tous le même ») : la
   * proposition suit ce que le poste demande tant que la personne n'en a pas
   * choisi un elle-même.
   */
  const [modeleChoisi, setModeleChoisi] = useState<string | null>(null);
  const modeles = etat?.modeles ?? [];
  const proposition = useMemo(
    () =>
      proposerModele(modeles, {
        outils: (toolsEnabled && (etat?.familles ?? []).some((f) => f.disponible)) || connaissances.length > 0 || fichiers.length > 0,
        longueurPoste: (instructions.trim() || description.trim()).length,
      }),
    [modeles, etat, toolsEnabled, connaissances.length, fichiers.length, instructions, description],
  );
  const modele = modeleChoisi ?? proposition?.uid ?? "";
  // Des modèles, mais aucun gratuit à proposer : un modèle facturé ne se choisit pas d'office.
  const modeleAChoisir = modeles.length > 0 && !modele;

  const reset = () => {
    setModeleChoisi(null);
    setPhoto(null);
    setName("");
    setDescription("");
    setInstructions("");
    setVisibility("personnel");
    setGroupIds([]);
    setHidePrompt(false);
    setToolsEnabled(true);
    setConnaissances([]);
    setFichiers([]);
    setAvantOptimisation(null);
    setErreurOptimisation(null);
  };

  return (
    <Modal
      open={open}
      onClose={() => {
        reset();
        onClose();
      }}
      size="xl"
    >
      <h2 className="text-lg font-semibold text-foreground">{t("Créer un nouvel agent")}</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        {t("Définissez le comportement et l'expertise de votre nouvel agent. Il est prêt à travailler dès sa création : on lui parle depuis sa fiche ou le Chat, et il peut prendre des missions régulières ou répondre sur une messagerie.")}
      </p>

      <div className="mt-5 grid gap-6 md:grid-cols-[220px_1fr]">
        {/* Colonne gauche : avatar + fichiers */}
        <div className="flex flex-col items-center gap-3 border-b border-border pb-5 md:border-b-0 md:border-e md:pb-0 md:pe-6">
          <ChoixPhotoAgent photo={photo ?? undefined} nom={name.trim() || t("Agent sans nom")} size={96} onChange={setPhoto} />
          <span className="text-sm font-medium text-foreground">
            {name.trim() || t("Agent sans nom")}
          </span>
          <span className="-mt-2 text-[11px] text-muted-foreground">{t("Cliquez sur l'avatar pour lui donner une photo")}</span>

          <div className="mt-2 w-full space-y-2">
            <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              <Paperclip size={12} strokeWidth={2} />{" "}{t("Fichiers de l'agent")}
            </p>
            {fichiers.length === 0 ? (
              <p className="text-xs text-muted-foreground">{t("Aucun fichier attaché")}</p>
            ) : (
              <ul className="space-y-1">
                {fichiers.map((f) => (
                  <li key={f.name} className="flex items-center gap-1.5 text-xs text-foreground">
                    <span className="min-w-0 flex-1 truncate" title={f.name}>
                      {f.name}
                    </span>
                    <button
                      type="button"
                      aria-label={tf("Retirer {0}", f.name)}
                      onClick={() => setFichiers((l) => l.filter((x) => x !== f))}
                      className="shrink-0 text-muted-foreground hover:text-destructive"
                    >
                      <X size={13} strokeWidth={2} />
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <input
              ref={choixFichiers}
              type="file"
              multiple
              accept={ACCEPT_DOCUMENTS}
              className="hidden"
              onChange={(e) => {
                const nouveaux = Array.from(e.target.files ?? []);
                setFichiers((l) => [...l.filter((x) => !nouveaux.some((n) => n.name === x.name)), ...nouveaux].slice(0, 40));
                e.target.value = "";
              }}
            />
            <Button variant="secondary" size="sm" icon={Plus} block onClick={() => choixFichiers.current?.click()}>
              {t("Ajouter un fichier")}
            </Button>
            <p className="text-[11px] text-muted-foreground">
              {t("PDF, Word, Excel, PowerPoint ou texte : il les consulte pour répondre.")}
            </p>
            <Button variant="secondary" size="sm" icon={Plus} block onClick={() => setDepuisEspace(true)}>
              {/* Une phrase entière : « Depuis » seul se traduisait « Since » (« Since OxoAI »), tournée à l'écran du 28/09/2026. */}
              {tf("Depuis {0}", branding.name)}
            </Button>
            {depuisEspace && (
              <ChoixDepuisEspace
                onFermer={() => setDepuisEspace(false)}
                onChoisis={(nouveaux) =>
                  setFichiers((l) => [...l.filter((x) => !nouveaux.some((n) => n.name === x.name)), ...nouveaux].slice(0, 40))
                }
              />
            )}
          </div>
        </div>

        {/* Colonne droite : formulaire */}
        <div className="space-y-4">
          <div className="space-y-1.5">
            <span className="text-sm font-medium text-foreground">{t("Visibilité")}</span>
            <ChoixVisibilite
              visibilite={visibility === "personnel" ? "prive" : visibility}
              groupes={groupIds}
              mesGroupes={mesGroupes}
              onChange={(v, g) => {
                setVisibility(v === "prive" ? "personnel" : v);
                setGroupIds(g);
              }}
            />
          </div>

          <Field label={t("Nom de l'agent")}>
            <Input
              placeholder={t("Ex: Agent juridique")}
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoFocus
            />
          </Field>

          <Field label={t("Description (optionnel)")}>
            <Input
              placeholder={t("Brève description de l'agent")}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </Field>

          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <label className="text-sm font-medium text-foreground">
                {t("Instructions (Prompt système)")}
              </label>
              {avantOptimisation !== null && !optimisation ? (
                <button
                  type="button"
                  onClick={() => {
                    setInstructions(avantOptimisation);
                    setAvantOptimisation(null);
                  }}
                  className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
                >
                  {t("Revenir à ma version")}
                </button>
              ) : (
                <button
                  type="button"
                  disabled={optimisation || (!name.trim() && !description.trim() && !instructions.trim())}
                  title={t("Le modèle de la machine réécrit vos instructions, sans en changer le sens")}
                  onClick={() => {
                    setOptimisation(true);
                    setErreurOptimisation(null);
                    void optimiserInstructions({ nom: name, description, instructions })
                      .then((propose) => {
                        if (!propose) throw new Error(t("Le modèle n'a rien proposé."));
                        setAvantOptimisation(instructions);
                        setInstructions(propose.slice(0, 50000));
                      })
                      .catch((err) => setErreurOptimisation(err instanceof Error ? err.message : String(err)))
                      .finally(() => setOptimisation(false));
                  }}
                  className="inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {optimisation ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} strokeWidth={1.75} />}
                  {optimisation ? t("Réécriture…") : t("Optimiser les instructions")}
                </button>
              )}
            </div>
            <Textarea
              rows={6}
              placeholder={t("Vous êtes un agent spécialisé en...")}
              value={instructions}
              onChange={(e) => setInstructions(e.target.value)}
              maxLength={50000}
            />
            <p className="flex justify-between gap-2 text-xs text-muted-foreground">
              <span className="text-destructive">{erreurOptimisation}</span>
              <span>{instructions.length}/50000</span>
            </p>
          </div>

          <div className="flex items-center justify-between">
            <span className="text-sm text-foreground">
              {t("Autoriser les outils (fichiers, connecteurs)")}
            </span>
            <Switch
              checked={toolsEnabled}
              onChange={setToolsEnabled}
              label={t("Autoriser les outils")}
            />
          </div>

          {features.bibliotheque && (
            <div className="space-y-1.5">
              <span className="text-sm text-foreground">{t("Bases de connaissances")}</span>
              <ChoixBases
                valeur={connaissances}
                onChange={setConnaissances}
                aide={t("L'agent y cherche avant de répondre et cite ses sources. Hors du Chat (sa fiche, ses missions, ses messageries), seulement dans ce qui est ouvert à toute l'équipe ; sans outils ni messagerie, aussi dans tout ce que vous voyez pour un agent personnel, et dans ce qui est partagé à chacun de ses groupes pour un agent de groupes. Sa carte le détaille une fois en service.")}
              />
            </div>
          )}

          {etat && (
            <div className="space-y-1">
              <ChoixModele modeles={modeles} valeur={modele} onChange={setModeleChoisi} proposition={proposition} />
              <p className="text-xs text-muted-foreground">
                {t("Il répond avec ce modèle sur sa fiche, dans ses missions et sur ses messageries ; il se change dans ses réglages. Dans le Chat, c'est le modèle choisi dans le Chat.")}
              </p>
            </div>
          )}

          {/*
            « Masquer le prompt aux non-administrateurs » retiré le 26/09/2026
            (revue de sécurité) : rien ne le faisait respecter. Les
            instructions d'un agent partagé partent vers chaque poste qui s'en
            sert, parce que c'est le poste qui les donne au modèle. Les cacher
            vraiment demande que l'instance les ajoute elle-même au Chat
            (PROJET.md, à faire). L'écran ne promet pas ce qui n'existe pas.
          */}
          {visibility !== "personnel" && (
            <div className="flex items-start justify-between gap-3">
              <span className="text-sm text-foreground">
                {t("Masquer ses instructions à celles et ceux à qui il est partagé")}
                <span className="block text-xs text-muted-foreground">
                  {t("Elles restent sur l'instance, qui les ajoute elle-même au Chat. Le modèle, lui, les lit : il a pour consigne de ne pas les répéter, mais une question insistante peut lui en faire dire une partie.")}
                </span>
              </span>
              <Switch checked={hidePrompt} onChange={setHidePrompt} label={t("Masquer ses instructions")} />
            </div>
          )}
        </div>
      </div>

      <div className="mt-6 flex justify-end gap-2">
        <Button
          variant="secondary"
          onClick={() => {
            reset();
            onClose();
          }}
        >
          {t("Annuler")}
        </Button>
        <Button
          disabled={!name.trim() || (visibility === "groupes" && groupIds.length === 0) || modeleAChoisir}
          onClick={() => {
            onCreate(
              { name, description, instructions, visibility, groupIds, hidePrompt, toolsEnabled, connaissances, ...(photo ? { photo } : {}), ...(modele ? { modeleEmploye: modele } : {}) },
              fichiers,
            );
            reset();
          }}
        >
          {t("Créer l'agent")}
        </Button>
      </div>
    </Modal>
  );
}

export default AgentsPage;
