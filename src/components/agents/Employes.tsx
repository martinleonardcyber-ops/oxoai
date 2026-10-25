import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import { getAgent } from "@/lib/store/agents";
import { AvatarAgent } from "@/components/ui/AvatarAgent";
import { photoValide } from "@/lib/photo";
import { joursSemaine } from "@/lib/tachesProgrammees";
import { useNavigate } from "react-router-dom";
import {
  Check,
  Loader2,
  Play,
  Plus,
  RefreshCw,
  Send,
  Trash2,
  TriangleAlert,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Field, Input, Textarea } from "@/components/ui/Field";
import { InfoBox } from "@/components/ui/InfoBox";
import { Modal } from "@/components/ui/Modal";
import { SegmentedTabs } from "@/components/ui/SegmentedTabs";
import { Select } from "@/components/ui/Select";
import { Switch } from "@/components/ui/Switch";
import { TexteRiche } from "@/components/ui/TexteRiche";
import { branding } from "@/config/branding";
import { cn } from "@/lib/cn";
import { formaterDateHeure } from "@/lib/formats";
import {
  attendreReponse,
  chargerEmployes,
  decrireRythme,
  DETAIL_FAMILLE,
  envoyerMessage,
  lancerMission,
  LIBELLE_FAMILLE,
  LIBELLE_RYTHME,
  lireActivite,
  lireEchanges,
  modifierEmploye,
  supprimerEmploye,
  type Echange,
  type Employe,
  type EtatEmployes,
  type Execution,
  type Famille,
  type Mission,
  type Rythme,
  type Liberte,
  type DocumentAgent,
  ACCEPT_DOCUMENTS,
  envoyerDocument,
  lireDocuments,
  retirerDocument,
  installerOpenClaw,
  libelleModele,
  nomCourtModele,
  proposerModele,
  texteModeleIndisponible,
  type EtatModele,
  type ModeleEmploye,
  type Proposition,
  PALIERS,
  estRefusMemoire,
  lireCopiesMemoire,
  restaurerMemoire,
  supprimerCopieMemoire,
  type CopieMemoire,
  type RaisonElargissement,
  ETAPES_EN_COURS,
  messageEtape,
} from "@/lib/employes";
import { lireEtat as lireEtatDeuxFacteurs } from "@/lib/deuxFacteurs";
import { useGroupes } from "@/lib/groupes";
import type { Visibilite } from "@/lib/bibliotheque";
import { ChoixVisibilite } from "@/pages/BibliothequePage";
import { CanauxEmploye } from "@/components/agents/CanauxEmploye";
import { ConfirmationMemoire } from "@/components/agents/ConfirmationMemoire";
import { ChoixDepuisEspace } from "@/components/agents/ChoixDepuisEspace";
import { updateAgent } from "@/lib/store/agents";
import { langue, t, tf, taille } from "@/lib/i18n";
import { nomDuPays } from "@/lib/fournisseurs";

/**
 * Employés : des agents qui travaillent pour toute l'équipe, jour et nuit, avec
 * un poste, des outils et des missions planifiées. Chacun leur parle dans sa
 * propre conversation. Tout se passe côté passerelle (gateway/src/employes.ts) ;
 * cet écran montre, déploie et converse.
 */

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

export function useEmployes() {
  const [etat, setEtat] = useState<EtatEmployes | null>(null);
  const [erreur, setErreur] = useState<string | null>(null);
  const recharger = useCallback(async () => {
    try {
      setEtat(await chargerEmployes());
      setErreur(null);
    } catch (err) {
      setErreur(message(err));
    }
  }, []);
  useEffect(() => {
    void recharger();
    const t = setInterval(() => void recharger(), 30_000);
    return () => clearInterval(t);
  }, [recharger]);
  return { etat, erreur, recharger };
}

/* ------------------------------------------------------------------ */
/* Section de la page Agents                                           */
/* ------------------------------------------------------------------ */

/**
 * Mise à jour d'OpenClaw vers la version que cette version de l'application a
 * éprouvée. Une version parue mais pas encore éprouvée est dite, pas proposée :
 * la configuration écrite pour les agents n'a été vérifiée que sur l'autre.
 */
export function MiseAJourOpenClaw({ etat, recharger }: { etat: EtatEmployes; recharger: () => Promise<void> }) {
  const [erreur, setErreur] = useState<string | null>(null);
  const inst = etat.moteur.installation;
  const enCours = ETAPES_EN_COURS.includes(inst.etape);
  useEffect(() => {
    if (!enCours) return;
    const t = setInterval(() => void recharger(), 2000);
    return () => clearInterval(t);
  }, [enCours, recharger]);

  if (enCours && etat.moteur.installe) {
    return (
      <p className="mt-4 flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 size={15} strokeWidth={1.75} className="shrink-0 animate-spin" />
        {messageEtape(inst)}
      </p>
    );
  }
  if (inst.etape === "termine" && inst.de) {
    return (
      <InfoBox tone="muted" className="mt-4" leading={<Check size={15} strokeWidth={1.75} />}>
        {inst.message}{" "}{t("Vos agents ont repris leur travail.")}
      </InfoBox>
    );
  }
  /*
   * Windows : OpenClaw installé, mais les bibliothèques Visual C++ de
   * Microsoft manquent, et deux de ses modules ne se chargent pas sans elles
   * (29/09/2026). Un bouton, et l'explication de la demande d'autorisation
   * qui va suivre.
   */
  if (etat.moteur.visualCpp) {
    return (
      <InfoBox tone="info" className="mt-4" leading={<TriangleAlert size={15} strokeWidth={1.75} />}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="min-w-0">
            {etat.moteur.visualCpp === "ancien"
              ? t("Les bibliothèques Visual C++ de Microsoft de ce PC sont plus anciennes que celles qu'OpenClaw demande : sans une version à jour, certains de ses modules ne se chargent pas.")
              : t("OpenClaw a besoin des bibliothèques Visual C++ de Microsoft, qui manquent sur ce PC : sans elles, certains de ses modules ne se chargent pas.")}{" "}
            {t("Le paquet officiel de Microsoft est téléchargé et vérifié, puis Windows vous demande une autorisation d'administrateur pour l'installer.")}
          </p>
          <Button
            size="sm"
            onClick={() => {
              setErreur(null);
              void installerOpenClaw()
                .then(recharger)
                .catch((err) => setErreur(message(err)));
            }}
          >
            {t("Installer les bibliothèques de Microsoft")}
          </Button>
        </div>
        {(inst.etape === "erreur" || erreur) && <p className="mt-2 text-sm">{erreur ?? inst.message}</p>}
      </InfoBox>
    );
  }
  if (inst.etape === "termine" && inst.redemarrage) {
    return (
      <InfoBox tone="muted" className="mt-4" leading={<Check size={15} strokeWidth={1.75} />}>
        {inst.message}
      </InfoBox>
    );
  }
  if (!etat.moteur.miseAJour) {
    if (!etat.moteur.parue) return null;
    return (
      <p className="mt-4 text-xs text-muted-foreground">
        {tf("OpenClaw {0} est paru. Vos agents restent sur la {1}, la version éprouvée avec {2} : une prochaine mise à jour de {2} les y fera passer, une fois vérifiée.", etat.moteur.parue, etat.moteur.version, branding.name)}
      </p>
    );
  }
  return (
    <InfoBox tone="info" className="mt-4" leading={<RefreshCw size={15} strokeWidth={1.75} />}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p>
          {tf("Mise à jour d'OpenClaw disponible : {0} vers {1}, la version éprouvée avec cette version de {2}. Vos agents s'interrompent une à deux minutes, le temps de l'installer. Si elle ne démarre pas, tout revient comme avant.", etat.moteur.version ?? "", etat.moteur.miseAJour, branding.name)}
        </p>
        <Button
          size="sm"
          onClick={() => {
            setErreur(null);
            void installerOpenClaw()
              .then(recharger)
              .catch((err) => setErreur(message(err)));
          }}
        >
          {t("Mettre à jour")}
        </Button>
      </div>
      {(inst.etape === "erreur" || erreur) && <p className="mt-2 text-sm">{erreur ?? inst.message}</p>}
    </InfoBox>
  );
}

const initiales = (nom: string) =>
  nom
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((m) => m[0]?.toUpperCase())
    .join("");

export function Statut({ employe, etat }: { employe: Employe; etat: EtatEmployes }) {
  const [texte, ton] = employe.enPause
    ? [t("En pause"), "bg-muted text-muted-foreground"]
    : etat.moteur.enMarche
      ? [t("En service"), "bg-success/15 text-success"]
      : [t("Arrêté"), "bg-warning/15 text-foreground"];
  return (
    <span className={cn("inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium", ton)}>
      <span className="h-1.5 w-1.5 rounded-full bg-current" />
      {texte}
    </span>
  );
}

/* ------------------------------------------------------------------ */
/* Réglages partagés                                                   */
/* ------------------------------------------------------------------ */

/** Documents de référence : ce qu'il consulte avant de répondre. S'enregistrent tout de suite. */
function DocumentsAgent({ employe }: { employe: Employe }) {
  const [documents, setDocuments] = useState<DocumentAgent[] | null>(null);
  const [depuisEspace, setDepuisEspace] = useState(false);
  const [occupe, setOccupe] = useState<string | null>(null);
  const [erreur, setErreur] = useState<string | null>(null);
  const choix = useRef<HTMLInputElement>(null);
  useEffect(() => {
    void lireDocuments(employe.id)
      .then(setDocuments)
      .catch(() => setDocuments([]));
  }, [employe.id]);

  const ajouter = async (fichiers: File[]) => {
    setErreur(null);
    for (const f of fichiers) {
      setOccupe(tf("Dépôt de {0}…", f.name));
      try {
        setDocuments(await envoyerDocument(employe.id, f, (p) => setOccupe(tf("Dépôt de {0}… {1} %", f.name, Math.round(p * 100)))));
      } catch (err) {
        setErreur(message(err));
        break;
      }
    }
    setOccupe(null);
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm font-medium text-foreground">{t("Ses documents de référence")}</p>
        <span className="flex gap-1">
          <Button variant="ghost" size="sm" icon={Plus} disabled={Boolean(occupe)} onClick={() => choix.current?.click()}>
            {t("Ajouter un fichier")}
          </Button>
          <Button variant="ghost" size="sm" disabled={Boolean(occupe)} onClick={() => setDepuisEspace(true)}>
            {tf("Depuis {0}", branding.name)}
          </Button>
        </span>
        {depuisEspace && <ChoixDepuisEspace onFermer={() => setDepuisEspace(false)} onChoisis={(f) => void ajouter(f)} />}
        <input
          ref={choix}
          type="file"
          multiple
          accept={ACCEPT_DOCUMENTS}
          className="hidden"
          onChange={(e) => {
            const f = Array.from(e.target.files ?? []);
            e.target.value = "";
            void ajouter(f);
          }}
        />
      </div>
      {documents === null ? null : documents.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          {t("Aucun. Tarifs, procédures, modèles de contrats : il les consulte avant de répondre.")}
        </p>
      ) : (
        <ul className="space-y-1 rounded-xl border border-border p-2">
          {documents.map((d) => (
            <li key={d.nom} className="flex items-center gap-2 px-1 text-sm">
              <span className="min-w-0 flex-1 truncate text-foreground" title={d.nom}>
                {d.nom}
              </span>
              <span className="shrink-0 text-xs text-muted-foreground">
                {taille(d.taille)}
                {!d.lisible && " · texte illisible"}
              </span>
              <button
                type="button"
                aria-label={tf("Retirer {0}", d.nom)}
                disabled={Boolean(occupe)}
                onClick={() => {
                  setErreur(null);
                  void retirerDocument(employe.id, d.nom)
                    .then(setDocuments)
                    .catch((err) => setErreur(message(err)));
                }}
                className="shrink-0 text-muted-foreground hover:text-destructive"
              >
                <X size={14} strokeWidth={1.75} />
              </button>
            </li>
          ))}
        </ul>
      )}
      {occupe && (
        <p className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 size={13} className="animate-spin" /> {occupe}
        </p>
      )}
      {erreur && <p className="text-xs text-destructive">{erreur}</p>}
      {(employe.canaux?.length ?? 0) > 0 && (documents?.length ?? 0) > 0 && (
        <p className="text-xs text-muted-foreground">
          {t("Les personnes qui lui écrivent sur une messagerie peuvent lui faire citer ces documents.")}
        </p>
      )}
    </div>
  );
}

function ChoixOutils({
  etat,
  valeur,
  onChange,
}: {
  etat: EtatEmployes;
  valeur: Famille[];
  onChange: (v: Famille[]) => void;
}) {
  const navigate = useNavigate();
  const indisponibles = etat.familles.filter((f) => !f.disponible);
  return (
    <div className="space-y-2">
      <p className="text-sm font-medium text-foreground">{t("Ses outils")}</p>
      <div className="grid gap-2 sm:grid-cols-2">
        {etat.familles.map(({ id, disponible }) => {
          const actif = valeur.includes(id);
          return (
            <label
              key={id}
              className={cn(
                "flex items-start gap-2.5 rounded-xl border px-3 py-2.5 text-sm",
                actif ? "border-foreground/30 bg-muted/50" : "border-border",
                disponible || actif ? "cursor-pointer" : "cursor-not-allowed opacity-55",
              )}
            >
              <input
                type="checkbox"
                className="mt-0.5 accent-current"
                checked={actif}
                disabled={!disponible && !actif}
                onChange={() => onChange(actif ? valeur.filter((f) => f !== id) : [...valeur, id])}
              />
              <span>
                <span className="block font-medium text-foreground">{LIBELLE_FAMILLE[id]}</span>
                <span className="block text-xs text-muted-foreground">
                  {disponible
                    ? DETAIL_FAMILLE[id]
                    : id === "bureau"
                      ? t("L'atelier bureautique n'est pas encore installé")
                      : t("Pas encore connecté sur l'instance")}
                </span>
              </span>
            </label>
          );
        })}
      </div>
      {indisponibles.length > 0 && (
        <p className="text-xs text-muted-foreground">
          {t("Pour en ouvrir d'autres :")}{" "}
          <button type="button" className="underline underline-offset-2" onClick={() => navigate("/parametres/mcp")}>
            {t("connecter un service")}
          </button>
          .
        </p>
      )}
    </div>
  );
}

/** Palier de liberté : trois choix. Le dernier se confirme (voir ConfirmationIdentite). */
function ChoixLiberte({
  valeur,
  onChange,
  windows,
}: {
  valeur: Liberte;
  onChange: (v: Liberte) => void;
  /** L'instance tourne sous Windows (OpenClaw natif, 28/09/2026) : ses commandes y passent par PowerShell. */
  windows: boolean;
}) {
  return (
    <div className="space-y-2">
      <p className="text-sm font-medium text-foreground">{t("Sa liberté d'action")}</p>
      <div className="grid gap-2 sm:grid-cols-3">
        {(Object.keys(PALIERS) as Liberte[]).map((p) => (
          <button
            key={p}
            type="button"
            onClick={() => onChange(p)}
            className={cn(
              "flex flex-col items-start gap-1 rounded-xl border px-3 py-2.5 text-start transition-colors",
              valeur === p ? "border-foreground/30 bg-muted/50" : "border-border hover:bg-muted/40",
            )}
          >
            <span className="text-sm font-medium text-foreground">{PALIERS[p].titre}</span>
            <span className="text-xs text-muted-foreground">{PALIERS[p].detail}</span>
          </button>
        ))}
      </div>
      {valeur === "libre" && (
        <InfoBox tone="warning" leading={<TriangleAlert size={15} strokeWidth={1.75} />}>
          {tf("Au palier Libre, il peut lancer n'importe quelle commande sur la machine de l'instance, avec les droits de {0} : installer, modifier, supprimer. Chaque outil qu'il utilise est inscrit au journal d'activité, mais pas le détail de la commande.", branding.name)}
          {/*
           * Windows natif : OpenClaw y lance ses commandes par PowerShell, pas
           * par un shell Unix (plateformeOpenClaw.ts). Dit ici, pour ce seul
           * palier : les autres ne lancent aucune commande.
           */}
          {windows && <>{" "}{t("Sur cette instance (Windows), ses commandes passent par PowerShell : une commande écrite pour macOS ou Linux peut ne pas y marcher.")}</>}
        </InfoBox>
      )}
    </div>
  );
}

/**
 * Confirmation d'identité pour les deux réglages qui retirent une barrière :
 * ouvrir le palier « libre », et rendre l'agent autonome. L'instance les
 * refuse tous les deux sans le mot de passe de la personne (et son code, si la
 * double authentification est active).
 */
function ConfirmationIdentite({
  raison,
  motDePasse,
  onMotDePasse,
  code,
  onCode,
}: {
  raison: string;
  motDePasse: string;
  onMotDePasse: (v: string) => void;
  code: string;
  onCode: (v: string) => void;
}) {
  const [deuxFacteurs, setDeuxFacteurs] = useState(false);
  useEffect(() => {
    void lireEtatDeuxFacteurs()
      .then((e) => setDeuxFacteurs(e.active))
      .catch(() => setDeuxFacteurs(false));
  }, []);
  return (
    <div className="space-y-2 rounded-xl border border-border p-3">
      <p className="text-sm text-foreground">{raison}</p>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={t("Votre mot de passe")}>
          <Input
            type="password"
            autoComplete="current-password"
            value={motDePasse}
            onChange={(e) => onMotDePasse(e.target.value)}
          />
        </Field>
        {deuxFacteurs && (
          <Field label={t("Code de vérification")}>
            <Input
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={32}
              value={code}
              onChange={(e) => onCode(e.target.value)}
            />
          </Field>
        )}
      </div>
    </div>
  );
}

/** Où partent ses messages, et qui paie : dit au moment du choix. */
function coutDuModele(m: ModeleEmploye): string {
  const chez = m.fournisseur ?? t("le fournisseur");
  const pays = m.pays ? ` (${nomDuPays(m.pays)})` : "";
  if (m.origine === "local") return t("Sur vos machines : rien ne sort, rien n'est facturé. Un modèle chargé répond le plus vite.");
  if (m.origine === "cle" && m.personnel) return tf("Cloud : ses messages partent chez {0}{1}, et chacune de ses réponses est facturée sur votre clé.", chez, pays);
  if (m.origine === "cle") return tf("Cloud : ses messages partent chez {0}{1}, et chacune de ses réponses est facturée à l'équipe, sur la clé de l'instance.", chez, pays);
  return tf("Cloud : ses messages partent chez {0}{1}, et sa consommation est facturée.", chez, pays);
}

/** Les modèles de la machine d'abord, puis ceux de l'intégrateur, puis ceux d'une clé (facturés). */
const RANG_ORIGINE: Record<ModeleEmploye["origine"], number> = { local: 0, agence: 1, cle: 2 };

/**
 * Le modèle d'un agent toujours actif (27/09/2026, demandé par Medhi : « pas
 * tous le même »), à la création comme dans ses réglages. La proposition dit
 * pourquoi en une ligne ; la personne décide. Un modèle qui a disparu reste
 * affiché comme tel, avec la raison : l'écran ne montre jamais un autre
 * modèle à sa place.
 */
export function ChoixModele({
  modeles,
  valeur,
  onChange,
  proposition,
  manquant,
}: {
  modeles: ModeleEmploye[];
  valeur: string;
  onChange: (v: string) => void;
  /** Le modèle proposé pour ce poste, et pourquoi. */
  proposition?: Proposition | null;
  /** Son modèle enregistré, quand il ne répond plus. */
  manquant?: { uid: string; etat: EtatModele; estProprietaire: boolean };
}) {
  const choisi = modeles.find((m) => m.uid === valeur);
  const options = [...modeles]
    .sort((a, b) => RANG_ORIGINE[a.origine] - RANG_ORIGINE[b.origine])
    .map((m) => ({ value: m.uid, label: libelleModele(m) }));
  if (manquant && !modeles.some((m) => m.uid === manquant.uid)) {
    options.unshift({ value: manquant.uid, label: tf("{0} (indisponible)", nomCourtModele(manquant.etat.nom)) });
  }
  const propose = proposition ? modeles.find((m) => m.uid === proposition.uid) : undefined;
  return (
    <div className="space-y-1.5">
      <span className="block text-sm font-medium text-foreground">{t("Son modèle")}</span>
      <Select value={valeur} onChange={onChange} options={options} />
      {manquant && valeur === manquant.uid && (
        <InfoBox tone="warning" leading={<TriangleAlert size={15} strokeWidth={1.75} />}>
          {texteModeleIndisponible(manquant.etat, manquant.estProprietaire)}
        </InfoBox>
      )}
      {choisi && <p className="text-xs text-muted-foreground">{coutDuModele(choisi)}</p>}
      {propose && proposition && (
        <p className="text-xs text-muted-foreground">
          {tf("Proposé pour ce poste : {0}, {1}.", nomCourtModele(propose.nom), proposition.raison)}
          {valeur !== proposition.uid && (
            <>
              {" "}
              <button type="button" className="underline underline-offset-2 hover:text-foreground" onClick={() => onChange(proposition.uid)}>
                {t("Le prendre")}
              </button>
            </>
          )}
        </p>
      )}
      {!proposition && modeles.length > 0 && !choisi && (
        <p className="text-xs text-muted-foreground">
          {t("Aucun modèle sur la machine de l'instance : choisissez-en un, facturé, ou installez un modèle.")}
        </p>
      )}
      {modeles.length === 0 && !manquant && (
        <p className="text-xs text-muted-foreground">{t("Aucun modèle de conversation n'est disponible pour l'instant.")}</p>
      )}
    </div>
  );
}

/**
 * Son modèle, en petit, dans la liste des agents : son nom, ou « modèle
 * indisponible » (la raison au survol), sans rien choisir à sa place.
 */
export function ModeleDiscret({ employe }: { employe: Employe }) {
  const etat = employe.modeleEtat;
  if (!etat) return null;
  if (!etat.disponible) {
    return (
      <span className="inline-flex items-center gap-1 text-[11px] text-warning" title={texteModeleIndisponible(etat, employe.estProprietaire)}>
        <TriangleAlert size={11} strokeWidth={2} />
        {t("Modèle indisponible")}
      </span>
    );
  }
  // Le nom du modèle d'un agent d'organisation ne revient qu'à son propriétaire (§ 36) : vide pour une collègue.
  if (!etat.nom) return null;
  return (
    <span className="max-w-[12rem] truncate text-[11px] text-muted-foreground" title={tf("Son modèle : {0}", etat.nom)}>
      {nomCourtModele(etat.nom)}
      {etat.origine === "cle" && ` · ${t("cloud")}`}
    </span>
  );
}

function ChoixAutonomie({ valeur, onChange }: { valeur: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="flex items-start justify-between gap-4 rounded-xl border border-border px-3 py-2.5">
      <div>
        <p className="text-sm font-medium text-foreground">{t("Agir sans demander d'accord")}</p>
        <p className="text-xs text-muted-foreground">
          {valeur
            ? t("Il modifie les fichiers et prépare ses brouillons de mail sans attendre personne. Un mail à envoyer attend l'accord d'une personne, sauf si l'envoi sans confirmation est permis dans Connecteurs, Courrier. Chaque action reste au journal d'activité, sous son nom.")
            : t("Chaque modification (écrire un fichier, préparer un brouillon de mail) et chaque envoi de mail attend l'accord d'une personne connectée. Sans réponse sous deux minutes, par exemple la nuit, elle n'est pas faite et il en est averti.")}
        </p>
      </div>
      <Switch checked={valeur} onChange={onChange} label={t("Agir sans demander d'accord")} />
    </div>
  );
}


function EditeurMissions({
  valeur,
  onChange,
  courrier,
}: {
  valeur: Mission[];
  onChange: (v: Mission[]) => void;
  /** Pour « à chaque mail reçu » : une boîte est-elle branchée, et y a-t-il accès ? */
  courrier: { branchee: boolean; acces: boolean };
}) {
  const changer = (i: number, m: Partial<Mission>) => onChange(valeur.map((x, j) => (j === i ? { ...x, ...m } : x)));
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <p className="text-sm font-medium text-foreground">{t("Ses missions régulières")}</p>
        {valeur.length < 12 && (
          <Button
            variant="ghost"
            size="sm"
            icon={Plus}
            onClick={() =>
              onChange([...valeur, { nom: "", consigne: "", rythme: "jours-ouvres", heure: "08:30" }])
            }
          >
            {t("Ajouter une mission")}
          </Button>
        )}
      </div>
      {valeur.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          {t("Aucune : il travaillera quand on lui parle. Une mission, c'est une consigne qu'il suit seul, au rythme choisi, puis dont il rend compte.")}
        </p>
      ) : (
        <ul className="space-y-2">
          {valeur.map((m, i) => (
            <li key={m.id ?? i} className="space-y-2 rounded-xl border border-border p-3">
              <div className="flex gap-2">
                <Input
                  placeholder={t("Nom de la mission")}
                  value={m.nom}
                  maxLength={80}
                  onChange={(e) => changer(i, { nom: e.target.value })}
                />
                <button
                  type="button"
                  aria-label={t("Retirer cette mission")}
                  onClick={() => onChange(valeur.filter((_, j) => j !== i))}
                  className="shrink-0 rounded-lg px-2 text-muted-foreground hover:text-destructive"
                >
                  <X size={16} strokeWidth={1.75} />
                </button>
              </div>
              <Textarea
                rows={2}
                placeholder={t("Ce qu'il doit faire, et ce qu'il doit rendre")}
                value={m.consigne}
                maxLength={2000}
                onChange={(e) => changer(i, { consigne: e.target.value })}
              />
              {/*
                Comme les tâches programmées (27/09/2026, demandé par Medhi) :
                le rythme, puis le jour s'il en faut un, puis l'heure, à la
                minute près.
              */}
              <div className="flex flex-wrap gap-2 [&>*]:min-w-[140px] [&>*]:flex-1">
                <Select
                  value={m.rythme}
                  onChange={(v) => {
                    const rythme = v as Rythme;
                    changer(i, { rythme, ...(rythme === "chaque-semaine" ? { jour: 1 } : rythme === "chaque-mois" ? { jour: 1 } : { jour: undefined }) });
                  }}
                  // « À chaque mail reçu » n'est plus proposé (27/09/2026, demandé par Medhi) ; une mission qui l'a le garde.
                  options={(Object.keys(LIBELLE_RYTHME) as Rythme[])
                    .filter((r) => r !== "a-chaque-mail" || m.rythme === "a-chaque-mail")
                    .map((r) => ({ value: r, label: LIBELLE_RYTHME[r] }))}
                />
                {m.rythme === "chaque-semaine" && (
                  <Select
                    value={String(m.jour ?? 1)}
                    onChange={(v) => changer(i, { jour: Number(v) })}
                    options={[1, 2, 3, 4, 5, 6, 0].map((j) => ({ value: String(j), label: joursSemaine()[j] ?? "" }))}
                  />
                )}
                {m.rythme === "chaque-mois" && (
                  <Select
                    value={String(m.jour ?? 1)}
                    onChange={(v) => changer(i, { jour: Number(v) })}
                    options={[
                      ...Array.from({ length: 28 }, (_, k) => ({ value: String(k + 1), label: tf("Le {0}", String(k + 1)) })),
                      { value: "-1", label: t("Le dernier jour") },
                    ]}
                  />
                )}
                {m.rythme === "a-chaque-mail" ? (
                  <Input
                    placeholder={t("Seulement de… (facultatif)")}
                    aria-label={t("Seulement les mails dont l'expéditeur contient")}
                    value={m.filtre?.de ?? ""}
                    maxLength={120}
                    onChange={(e) => changer(i, { filtre: { ...m.filtre, de: e.target.value } })}
                  />
                ) : m.rythme === "chaque-heure" ? null : (
                  <Input type="time" aria-label={t("Heure")} value={m.heure} onChange={(e) => e.target.value && changer(i, { heure: e.target.value })} />
                )}
              </div>
              {m.rythme === "a-chaque-mail" && (
                <>
                  <Input
                    placeholder={t("Seulement si l'objet contient… (facultatif)")}
                    aria-label={t("Seulement les mails dont l'objet contient")}
                    value={m.filtre?.objet ?? ""}
                    maxLength={120}
                    onChange={(e) => changer(i, { filtre: { ...m.filtre, objet: e.target.value } })}
                  />
                  <p className="text-xs text-muted-foreground">
                    {!courrier.branchee
                      ? t("Aucune boîte mail n'est branchée : faites-le dans Réglages, Connecteurs. La mission attendra.")
                      : !courrier.acces
                        ? t("Il lui faut l'accès à la boîte mail : cochez « Courrier » dans ses outils ci-dessus.")
                        : t("La boîte est relevée toutes les deux minutes. Chaque nouveau mail lui est confié, avec la consigne ci-dessus ; s'il doit répondre, il prépare un brouillon. Il n'envoie rien de lui-même : un envoi attend toujours l'accord d'une personne, quels que soient les réglages, puisque le mail vient de l'extérieur.")}
                  </p>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
      {valeur.length > 0 && (
        <p className="text-xs text-muted-foreground">
          {tf("Les missions tournent tant que l'instance fonctionne : ordinateur allumé et {0} ouvert (la fenêtre peut être fermée), ou serveur hébergé.", branding.name)}
        </p>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Panneau d'un employé                                                */
/* ------------------------------------------------------------------ */

export function PanneauEmploye({
  employe,
  etat,
  onFermer,
  onChange,
  onRetire,
}: {
  employe: Employe;
  etat: EtatEmployes;
  onFermer: () => void;
  onChange: () => Promise<void>;
  /** Appelé quand son propriétaire le retire : l'agent qui l'a fait naître part avec lui. */
  onRetire?: () => void;
}) {
  const [onglet, setOnglet] = useState("discuter");
  const onglets = [
    { id: "discuter", label: t("Chat") },
    { id: "missions", label: tf("Missions ({0})", employe.missions.length) },
    { id: "activite", label: t("Activité") },
    { id: "canaux", label: tf("Canaux ({0})", employe.canaux?.length ?? 0) },
    ...(employe.estProprietaire ? [{ id: "reglages", label: t("Réglages") }] : []),
  ];
  return (
    <Modal open onClose={onFermer} size="xl">
      <div className="flex items-start gap-3 pe-8">
        {/* La photo de son agent, s'il en a une (27/09/2026) ; sinon ses initiales. */}
        {photoValide(employe.agentId ? getAgent(employe.agentId)?.photo : undefined) ? (
          <AvatarAgent photo={getAgent(employe.agentId!)?.photo} nom={employe.nom} size={44} />
        ) : (
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-muted font-semibold text-foreground">
            {initiales(employe.nom)}
          </span>
        )}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-lg font-semibold text-foreground">{employe.nom}</h2>
            <Statut employe={employe} etat={etat} />
          </div>
          <p className="text-xs text-muted-foreground">
            {t("Créé par")}{" "}{employe.proprietaire}
            {employe.modeleEtat?.disponible && employe.modeleEtat.nom && tf(" · modèle {0}", nomCourtModele(employe.modeleEtat.nom))}
            {employe.jetons30Jours > 0 &&
              tf(" · {0} jetons sur 30 jours", employe.jetons30Jours.toLocaleString(langue()))}
          </p>
        </div>
      </div>
      {/* Son modèle a disparu : dit en tête de sa fiche, sans qu'un autre réponde à sa place. */}
      {employe.modeleEtat && !employe.modeleEtat.disponible && (
        <InfoBox tone="warning" className="mt-3" leading={<TriangleAlert size={15} strokeWidth={1.75} />}>
          {texteModeleIndisponible(employe.modeleEtat, employe.estProprietaire)}
        </InfoBox>
      )}
      <SegmentedTabs className="mt-4" size="sm" options={onglets} value={onglet} onChange={setOnglet} />
      <div className="mt-4 min-h-[340px]">
        {onglet === "discuter" && <Conversation employe={employe} />}
        {onglet === "missions" && <Missions employe={employe} etat={etat} onChange={onChange} />}
        {onglet === "activite" && <Activite employe={employe} />}
        {onglet === "canaux" && <CanauxEmploye employe={employe} etat={etat} onChange={onChange} />}
        {onglet === "reglages" && (
          <Reglages
            employe={employe}
            etat={etat}
            onChange={onChange}
            onRetire={() => {
              onRetire?.();
              onFermer();
            }}
          />
        )}
      </div>
    </Modal>
  );
}

function Conversation({ employe }: { employe: Employe }) {
  const [echanges, setEchanges] = useState<Echange[]>([]);
  const [attente, setAttente] = useState<{ question: string; depuis: number } | null>(null);
  const [texte, setTexte] = useState("");
  const [erreur, setErreur] = useState<string | null>(null);
  const [secondes, setSecondes] = useState(0);
  const fin = useRef<HTMLDivElement>(null);
  const abandon = useRef<AbortController | null>(null);

  const suivre = useCallback(
    async (travail: string, question: string, depuis: number) => {
      abandon.current?.abort();
      const controle = new AbortController();
      abandon.current = controle;
      setAttente({ question, depuis });
      try {
        await attendreReponse(employe.id, travail, controle.signal);
        const r = await lireEchanges(employe.id);
        setEchanges(r.echanges);
        setAttente(null);
      } catch (err) {
        if (controle.signal.aborted) return;
        setErreur(message(err));
        setAttente(null);
      }
    },
    [employe.id],
  );

  useEffect(() => {
    void lireEchanges(employe.id)
      .then((r) => {
        setEchanges(r.echanges);
        // Un message encore en cours, envoyé avant d'avoir quitté l'écran : on le reprend.
        if (r.enCours) void suivre(r.enCours.travail, r.enCours.question, Date.parse(r.enCours.depuis));
      })
      .catch((err) => setErreur(message(err)));
    return () => abandon.current?.abort();
  }, [employe.id, suivre]);

  useEffect(() => {
    if (!attente) return;
    const t = setInterval(() => setSecondes(Math.round((Date.now() - attente.depuis) / 1000)), 1000);
    return () => clearInterval(t);
  }, [attente]);

  // Entre accolades : les navigateurs récents font rendre une promesse à
  // `scrollIntoView`, et React prendrait cette valeur pour une fonction de nettoyage.
  useEffect(() => {
    fin.current?.scrollIntoView({ block: "end" });
  }, [echanges, attente]);

  const envoyer = async () => {
    const question = texte.trim();
    if (!question || attente) return;
    setErreur(null);
    /*
     * L'attente s'affiche dès l'envoi : quand l'instance des agents démarre
     * (ou ne s'ouvre pas), la passerelle peut mettre jusqu'à 45 s à répondre,
     * et rien ne bougeait à l'écran, bouton « Envoyer » toujours actif.
     */
    const depuis = Date.now();
    setSecondes(0);
    setAttente({ question, depuis });
    try {
      const travail = await envoyerMessage(employe.id, question);
      setTexte("");
      void suivre(travail, question, depuis);
    } catch (err) {
      setAttente(null);
      setErreur(message(err));
    }
  };

  const touche = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void envoyer();
    }
  };

  return (
    <div className="flex h-[420px] flex-col">
      <div className="flex-1 space-y-4 overflow-y-auto pe-1">
        {echanges.length === 0 && !attente && (
          <p className="pt-10 text-center text-sm text-muted-foreground">
            {t("Demandez-lui ce que vous voulez dans le cadre de son poste.")}
          </p>
        )}
        {echanges.map((x, i) => (
          <div key={i} className="space-y-2">
            <Bulle question={x.question} />
            <TexteRiche
              texte={x.reponse}
              className={cn("text-sm leading-relaxed", x.ok ? "text-foreground" : "text-muted-foreground")}
            />
            <p className="text-[11px] text-muted-foreground">{formaterDateHeure(x.quand)}</p>
          </div>
        ))}
        {attente && (
          <div className="space-y-2">
            <Bulle question={attente.question} />
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 size={15} strokeWidth={1.75} className="animate-spin" />
              {employe.nom}{" "}{t("y travaille")}
              {secondes > 5 &&
                (secondes >= 60
                  ? tf(" depuis {0} min {1} s", Math.floor(secondes / 60), secondes % 60)
                  : tf(" depuis {0} s", secondes))}
              {t(". Vous pouvez fermer : la réponse vous attendra ici.")}
            </p>
          </div>
        )}
        <div ref={fin} />
      </div>
      {erreur && (
        <InfoBox tone="warning" className="mt-2" leading={<TriangleAlert size={15} strokeWidth={1.75} />}>
          {erreur}
        </InfoBox>
      )}
      <div className="mt-3 flex items-end gap-2">
        <Textarea
          rows={2}
          value={texte}
          maxLength={8000}
          disabled={employe.enPause}
          placeholder={employe.enPause ? tf("{0} est en pause.", employe.nom) : tf("Écrire à {0}…", employe.nom)}
          onChange={(e) => setTexte(e.target.value)}
          onKeyDown={touche}
        />
        <Button icon={Send} disabled={!texte.trim() || Boolean(attente) || employe.enPause} onClick={() => void envoyer()}>
          {t("Envoyer")}
        </Button>
      </div>
      <p className="mt-1.5 text-[11px] text-muted-foreground">
        {t("Cette conversation n'est visible que par vous.")}{" "}{employe.nom}{" "}{t("peut en garder des notes utiles à son travail.")}
      </p>
    </div>
  );
}

function Bulle({ question }: { question: string }) {
  return (
    <div className="flex justify-end">
      <p className="max-w-[80%] whitespace-pre-wrap rounded-2xl bg-muted px-3.5 py-2 text-sm text-foreground">{question}</p>
    </div>
  );
}

function Missions({ employe, etat, onChange }: { employe: Employe; etat: EtatEmployes; onChange: () => Promise<void> }) {
  const [info, setInfo] = useState<string | null>(null);
  const [lancee, setLancee] = useState<string | null>(null);
  /*
   * Ses missions se créent et se modifient ici aussi (27/09/2026, demandé par
   * Medhi : l'onglet disait « Ajoutez-en dans Réglages »). Même éditeur, même
   * enregistrement que dans Réglages : seules les missions changent.
   */
  const [edition, setEdition] = useState<Mission[] | null>(null);
  const [occupe, setOccupe] = useState(false);
  const courrier = {
    branchee: Boolean(etat.familles.find((f) => f.id === "courrier")?.disponible),
    acces: Boolean(employe.toutesLesFamilles) || employe.outils.includes("courrier"),
  };
  const nouvelle = (): Mission => ({ nom: "", consigne: "", rythme: "jours-ouvres", heure: "08:30" });

  if (edition) {
    const enregistrer = async () => {
      setOccupe(true);
      setInfo(null);
      try {
        const r = await modifierEmploye(employe.id, { missions: edition.filter((m) => m.nom.trim() || m.consigne.trim()) });
        await onChange();
        setEdition(null);
        setInfo(r.avertissement ?? t("Missions enregistrées."));
      } catch (err) {
        setInfo(message(err));
      } finally {
        setOccupe(false);
      }
    };
    return (
      <div className="space-y-3">
        <EditeurMissions valeur={edition} onChange={setEdition} courrier={courrier} />
        {info && <InfoBox tone="muted">{info}</InfoBox>}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" size="sm" disabled={occupe} onClick={() => { setEdition(null); setInfo(null); }}>
            {t("Annuler")}
          </Button>
          <Button size="sm" icon={occupe ? Loader2 : Check} disabled={occupe} onClick={() => void enregistrer()}>
            {t("Enregistrer les missions")}
          </Button>
        </div>
      </div>
    );
  }

  if (employe.missions.length === 0) {
    return (
      <div className="flex flex-col items-center gap-3 pt-10 text-center">
        <p className="max-w-md text-sm text-muted-foreground">
          {t("Aucune mission planifiée. Une mission, c'est une consigne qu'il suit seul, au rythme choisi, puis dont il rend compte.")}
        </p>
        {employe.estProprietaire && (
          <Button size="sm" icon={Plus} onClick={() => setEdition([nouvelle()])}>
            {t("Ajouter une mission")}
          </Button>
        )}
        {info && <InfoBox tone="muted">{info}</InfoBox>}
      </div>
    );
  }
  return (
    <div className="space-y-2">
      {employe.estProprietaire && (
        <div className="flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={() => setEdition(employe.missions.map((m) => ({ ...m })))}>
            {t("Modifier les missions")}
          </Button>
          {employe.missions.length < 12 && (
            <Button variant="secondary" size="sm" icon={Plus} onClick={() => setEdition([...employe.missions.map((m) => ({ ...m })), nouvelle()])}>
              {t("Ajouter une mission")}
            </Button>
          )}
        </div>
      )}
      {employe.missions.map((m) => (
        <div key={m.id} className="rounded-xl border border-border p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <p className="text-sm font-medium text-foreground">{m.nom}</p>
              <p className="text-xs text-muted-foreground">
                {decrireRythme(m)}
                {!m.planifiee &&
                  !employe.enPause &&
                  (m.rythme === "a-chaque-mail" ? t(" · en attente d'une boîte mail, voir Réglages") : t(" · non planifiée, voir Réglages"))}
                {employe.enPause && t(" · suspendue pendant la pause")}
              </p>
            </div>
            {employe.estProprietaire && m.id && m.planifiee && (
              <Button
                variant="secondary"
                size="sm"
                icon={Play}
                disabled={lancee === m.id}
                onClick={() => {
                  setLancee(m.id ?? null);
                  setInfo(null);
                  void lancerMission(employe.id, m.id ?? "")
                    .then(() =>
                      setInfo(
                        m.rythme === "a-chaque-mail"
                          ? tf("« {0} » traite le dernier mail reçu : son compte rendu arrivera dans Activité.", m.nom)
                          : tf("« {0} » est lancée : son compte rendu arrivera dans Activité.", m.nom),
                      ),
                    )
                    .catch((err) => setInfo(message(err)))
                    .finally(() => setLancee(null));
                }}
              >
                {m.rythme === "a-chaque-mail" ? t("Essayer sur le dernier mail") : t("Lancer maintenant")}
              </Button>
            )}
          </div>
          <p className="mt-2 whitespace-pre-wrap text-sm text-muted-foreground">{m.consigne}</p>
        </div>
      ))}
      {info && <InfoBox tone="muted">{info}</InfoBox>}
      {!employe.estProprietaire && (
        <p className="text-xs text-muted-foreground">
          {t("Seule la personne qui l'a créé (")}{employe.proprietaire}{t(") peut modifier ou lancer ses missions.")}
        </p>
      )}
    </div>
  );
}

const STATUT_EXECUTION: Record<string, string> = {
  ok: t("Terminée"),
  error: t("Échec"),
  skipped: t("Reportée (modèle injoignable)"),
  running: t("En cours"),
};

function Activite({ employe }: { employe: Employe }) {
  const [executions, setExecutions] = useState<Execution[] | null>(null);
  const [erreur, setErreur] = useState<string | null>(null);
  // L'instance n'a pas pu dire ses exécutions : la liste montrée n'est pas complète, et on le dit.
  const [avertissement, setAvertissement] = useState<string | null>(null);
  const charger = useCallback(() => {
    void lireActivite(employe.id)
      .then((r) => {
        setErreur(null);
        setExecutions(r.executions);
        setAvertissement(r.avertissement ?? null);
      })
      .catch((err) => setErreur(message(err)));
  }, [employe.id]);
  useEffect(charger, [charger]);

  if (erreur) return <InfoBox tone="warning">{erreur}</InfoBox>;
  if (!executions) return <Loader2 size={18} strokeWidth={1.75} className="mx-auto mt-10 animate-spin text-muted-foreground" />;
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <p className="text-xs text-muted-foreground">{t("Les dernières missions faites, avec leur compte rendu.")}</p>
        <Button variant="ghost" size="sm" icon={RefreshCw} onClick={charger}>
          {t("Actualiser")}
        </Button>
      </div>
      {avertissement && (
        <InfoBox tone="warning" leading={<TriangleAlert size={15} strokeWidth={1.75} />}>
          {avertissement}
        </InfoBox>
      )}
      {executions.length === 0 ? (
        !avertissement && <p className="pt-8 text-center text-sm text-muted-foreground">{t("Aucune mission faite pour l'instant.")}</p>
      ) : (
        <ul className="max-h-[360px] space-y-2 overflow-y-auto">
          {executions.map((x, i) => (
            <li key={i} className="rounded-xl border border-border p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-sm font-medium text-foreground">{x.mission}</p>
                <p className="text-xs text-muted-foreground">
                  {STATUT_EXECUTION[x.statut] ?? x.statut} · {x.quand ? formaterDateHeure(x.quand) : ""}
                  {x.dureeMs ? ` · ${tf("{0} s", Math.round(x.dureeMs / 1000))}` : ""}
                </p>
              </div>
              {x.resume && <TexteRiche texte={x.resume} className="mt-2 text-sm text-muted-foreground" />}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * Ses mémoires mises de côté avant un élargissement de son audience
 * (gateway/src/employes.ts, `viderMemoire`) : les remettre dans son espace,
 * tant qu'il n'est pas plus ouvert qu'au moment de la copie, ou les supprimer.
 * Rien n'est affiché quand il n'y en a pas.
 */
function MemoireMiseDeCote({ employe }: { employe: Employe }) {
  const [copies, setCopies] = useState<CopieMemoire[] | null>(null);
  const [occupe, setOccupe] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const recharger = useCallback(async () => {
    try {
      setCopies((await lireCopiesMemoire(employe.id)).copies);
    } catch (err) {
      setInfo(message(err));
    }
  }, [employe.id]);
  useEffect(() => {
    void recharger();
  }, [recharger, employe.updatedAt]);

  if (!copies || copies.length === 0) return info ? <InfoBox tone="muted">{info}</InfoBox> : null;
  const agir = async (id: string, action: () => Promise<string>) => {
    setOccupe(id);
    setInfo(null);
    try {
      setInfo(await action());
      await recharger();
    } catch (err) {
      setInfo(message(err));
    } finally {
      setOccupe(null);
    }
  };
  return (
    <div className="space-y-2 rounded-xl border border-border p-3">
      <p className="text-sm font-medium text-foreground">{t("Mémoire mise de côté")}</p>
      <p className="text-xs text-muted-foreground">
        {t("Copies chiffrées de ses notes, faites avant que son audience s'élargisse. Les restaurer n'est possible que s'il est redevenu aussi fermé qu'au moment de la copie. Les conversations, elles, ne reviennent pas.")}
      </p>
      <ul className="space-y-1.5">
        {copies.map((c) => (
          <li key={c.id} className="flex flex-wrap items-center gap-2 text-sm">
            <span className="min-w-0 flex-1 text-foreground">
              {formaterDateHeure(c.quand)}
              <span className="text-muted-foreground">
                {" · "}
                {tf("{0} note(s), {1} conversation(s) effacée(s)", c.fichiers, c.conversations)}
              </span>
            </span>
            <Button
              size="sm"
              variant="secondary"
              disabled={occupe !== null || !c.restaurable}
              title={c.restaurable ? undefined : t("Il est aujourd'hui plus ouvert qu'au moment de la copie : refermez-le d'abord.")}
              onClick={() =>
                void agir(c.id, async () => tf("{0} note(s) remise(s) dans sa mémoire.", (await restaurerMemoire(employe.id, c.id)).fichiers))
              }
            >
              {t("Restaurer")}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              icon={Trash2}
              disabled={occupe !== null}
              onClick={() =>
                void agir(c.id, async () => {
                  await supprimerCopieMemoire(employe.id, c.id);
                  return t("Copie supprimée.");
                })
              }
            >
              {t("Supprimer")}
            </Button>
          </li>
        ))}
      </ul>
      {info && <p className="text-xs text-muted-foreground">{info}</p>}
    </div>
  );
}

function Reglages({
  employe,
  etat,
  onChange,
  onRetire,
}: {
  employe: Employe;
  etat: EtatEmployes;
  onChange: () => Promise<void>;
  onRetire: () => void;
}) {
  const [poste, setPoste] = useState(employe.poste);
  const [outils, setOutils] = useState<Famille[]>(employe.outils);
  const [toutes, setToutes] = useState(Boolean(employe.toutesLesFamilles));
  const [missions, setMissions] = useState<Mission[]>(employe.missions);
  const [autonome, setAutonome] = useState(Boolean(employe.autonome));
  const [modele, setModele] = useState(employe.modele);
  const [liberte, setLiberte] = useState<Liberte>(employe.liberte ?? "encadre");
  const [motDePasse, setMotDePasse] = useState("");
  const [code, setCode] = useState("");
  const [occupe, setOccupe] = useState(false);
  const [info, setInfo] = useState<string | null>(null);
  const [confirmer, setConfirmer] = useState(false);
  // Qui le voit et lui parle : le choix de la Bibliothèque, « Vous seul » valant « Personnel ».
  const { etat: groupes } = useGroupes();
  const mesGroupes = (groupes?.groupes ?? []).filter((g) => g.estMembre || (employe.groupes ?? []).includes(g.id));
  const [vis, setVis] = useState<{ v: Visibilite; g: string[] }>({
    v: employe.visibilite === "personnel" ? "prive" : (employe.visibilite ?? "organisation"),
    g: employe.groupes ?? [],
  });
  const visibilite: NonNullable<Employe["visibilite"]> = vis.v === "prive" ? "personnel" : vis.v;
  const visibiliteChangee =
    visibilite !== (employe.visibilite ?? "organisation") ||
    (visibilite === "groupes" && [...vis.g].sort().join(",") !== [...(employe.groupes ?? [])].sort().join(","));
  /** L'instance attend la confirmation de vider sa mémoire (élargissement de son audience). */
  const [memoire, setMemoire] = useState<RaisonElargissement[] | null>(null);

  /*
   * Deux réglages retirent une barrière, et l'instance redemande le mot de
   * passe pour les deux : ouvrir le palier « libre », et rendre l'agent
   * autonome, c'est-à-dire lui permettre d'agir sans jamais demander.
   */
  const aConfirmer =
    (liberte === "libre" && employe.liberte !== "libre") ||
    (autonome && !employe.autonome);

  const agir = async (action: () => Promise<{ avertissement?: string } | void>, succes: string) => {
    setOccupe(true);
    setInfo(null);
    try {
      const r = await action();
      setMemoire(null);
      setInfo(r && r.avertissement ? r.avertissement : succes);
      await onChange();
    } catch (err) {
      // Son audience s'élargirait sur une mémoire pleine : rien n'est fait, on demande d'abord.
      if (estRefusMemoire(err)) setMemoire((err.details?.raisons as RaisonElargissement[] | undefined) ?? []);
      else setInfo(message(err));
    } finally {
      setOccupe(false);
    }
  };

  const enregistrer = (viderMemoire: boolean) =>
    agir(
      async () => {
        const r = await modifierEmploye(employe.id, {
          poste,
          outils,
          toutesLesFamilles: toutes,
          missions,
          autonome,
          // Seulement s'il change : son modèle disparu, le reste de ses réglages s'enregistre quand même.
          ...(modele !== employe.modele ? { modele } : {}),
          liberte,
          ...(visibiliteChangee ? { visibilite, ...(visibilite === "groupes" ? { groupes: vis.g } : {}) } : {}),
          ...(aConfirmer ? { motDePasse, code: code.trim() || undefined } : {}),
          ...(viderMemoire ? { viderMemoire: true } : {}),
        });
        /*
         * L'agent et son employé ne font qu'un : ses instructions (celles
         * que le Chat lui donne) suivent le poste, et sa visibilité celle
         * de l'employé. Seulement une fois l'instance d'accord : recopiés
         * avant, un enregistrement refusé (mission « à chaque mail » sans
         * accès au courrier, instance injoignable, mémoire à vider) laissait
         * le Chat et l'agent 24/7 obéir à deux réglages différents.
         */
        if (employe.agentId && (poste !== employe.poste || visibiliteChangee || modele !== employe.modele)) {
          updateAgent(employe.agentId, {
            ...(poste !== employe.poste ? { instructions: r.employe.poste } : {}),
            ...(modele !== employe.modele ? { modeleEmploye: r.employe.modele } : {}),
            ...(visibiliteChangee
              ? {
                  visibility: r.employe.visibilite ?? "organisation",
                  groupIds: r.employe.visibilite === "groupes" ? (r.employe.groupes ?? []) : undefined,
                }
              : {}),
          });
          window.dispatchEvent(new Event("oxoai:agents-changed"));
        }
        return r;
      },
      t("Modifications enregistrées."),
    );

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between rounded-xl border border-border px-3 py-2.5">
        <div>
          <p className="text-sm font-medium text-foreground">{employe.enPause ? t("En pause") : t("En service")}</p>
          <p className="text-xs text-muted-foreground">
            {t("En pause, il ne répond plus et ses missions sont suspendues.")}
          </p>
        </div>
        <Switch
          checked={!employe.enPause}
          label={t("En service")}
          onChange={(v) =>
            void agir(() => modifierEmploye(employe.id, { enPause: !v }), v ? tf("{0} reprend le travail.", employe.nom) : tf("{0} est en pause.", employe.nom))
          }
        />
      </div>
      <Field label={t("Son poste")}>
        <Textarea rows={4} value={poste} maxLength={50000} onChange={(e) => setPoste(e.target.value)} />
      </Field>
      <div className="space-y-1.5">
        <p className="text-sm font-medium text-foreground">{t("Qui le voit et lui parle")}</p>
        <ChoixVisibilite
          visibilite={vis.v}
          groupes={vis.g}
          mesGroupes={mesGroupes}
          onChange={(v, g) => {
            setVis({ v, g });
            setMemoire(null);
          }}
        />
        <p className="text-xs text-muted-foreground">
          {vis.v === "groupes"
            ? t("Seuls les membres de ces groupes le voient, lui parlent et l'utilisent dans le Chat. Qui quitte un groupe ne le voit plus.")
            : vis.v === "prive"
              ? t("Personne d'autre ne le voit ni ne lui parle.")
              : t("Chaque compte de l'instance le voit et lui parle, chacun dans sa conversation.")}
        </p>
      </div>
      <div className="flex items-start justify-between gap-4 rounded-xl border border-border px-3 py-2.5">
        <div>
          <p className="text-sm font-medium text-foreground">{t("Tous les services branchés")}</p>
          <p className="text-xs text-muted-foreground">
            {toutes
              ? t("Il se sert de tout ce qui est branché sur l'instance, y compris ce qui le sera plus tard.")
              : t("Il ne se sert que des services cochés ci-dessous.")}
          </p>
        </div>
        <Switch checked={toutes} onChange={setToutes} label={t("Tous les services branchés")} />
      </div>
      {!toutes && <ChoixOutils etat={etat} valeur={outils} onChange={setOutils} />}
      <EditeurMissions
        valeur={missions}
        onChange={setMissions}
        courrier={{
          branchee: Boolean(etat.familles.find((f) => f.id === "courrier")?.disponible),
          acces: toutes || outils.includes("courrier"),
        }}
      />
      <DocumentsAgent employe={employe} />
      <ChoixModele
        modeles={etat.modeles}
        valeur={modele}
        onChange={setModele}
        proposition={proposerModele(etat.modeles, {
          outils:
            (toutes ? etat.familles.some((f) => f.disponible) : outils.some((o) => etat.familles.find((f) => f.id === o)?.disponible)) ||
            (employe.connaissances?.length ?? 0) > 0,
          longueurPoste: poste.trim().length,
        })}
        manquant={employe.modeleEtat && !employe.modeleEtat.disponible ? { uid: employe.modele, etat: employe.modeleEtat, estProprietaire: true } : undefined}
      />
      <ChoixAutonomie valeur={autonome} onChange={setAutonome} />
      <ChoixLiberte valeur={liberte} onChange={setLiberte} windows={etat.moteur.plateforme === "win32"} />
      {aConfirmer && (
        <ConfirmationIdentite
          raison={
            liberte === "libre" && employe.liberte !== "libre"
              ? t("Ouvrir le palier Libre donne à cet agent les commandes de la machine : confirmez que c'est bien vous.")
              : t("Rendre cet agent autonome retire la demande d'accord avant chacune de ses actions : confirmez que c'est bien vous.")
          }
          motDePasse={motDePasse}
          onMotDePasse={setMotDePasse}
          code={code}
          onCode={setCode}
        />
      )}
      <MemoireMiseDeCote employe={employe} />
      {memoire && (
        <ConfirmationMemoire
          nom={employe.nom}
          raisons={memoire}
          occupe={occupe}
          onConfirmer={() => void enregistrer(true)}
          onAnnuler={() => setMemoire(null)}
        />
      )}
      {info && <InfoBox tone="muted">{info}</InfoBox>}
      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-4">
        {confirmer ? (
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm text-foreground">
              {tf("Retirer {0} ? Ses missions, son espace et les conversations de chacun avec lui disparaissent.", employe.nom)}
            </span>
            <Button
              variant="destructive"
              size="sm"
              disabled={occupe}
              onClick={() =>
                void agir(async () => {
                  await supprimerEmploye(employe.id);
                  onRetire();
                }, tf("{0} a été retiré.", employe.nom))
              }
            >
              {t("Retirer")}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setConfirmer(false)}>
              {t("Annuler")}
            </Button>
          </div>
        ) : (
          <Button variant="ghost" size="sm" icon={Trash2} onClick={() => setConfirmer(true)}>
            {tf("Retirer {0}", employe.nom)}
          </Button>
        )}
        <Button
          disabled={occupe || !poste.trim() || memoire !== null || (vis.v === "groupes" && vis.g.length === 0)}
          onClick={() => void enregistrer(false)}
        >
          {occupe ? t("Enregistrement…") : t("Enregistrer")}
        </Button>
      </div>
    </div>
  );
}

export default PanneauEmploye;
