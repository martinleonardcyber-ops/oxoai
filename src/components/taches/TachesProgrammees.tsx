import { useCallback, useEffect, useState } from "react";
import { Select } from "@/components/ui/Select";
import { useNavigate } from "react-router-dom";
import { Bot, CalendarClock, Check, ChevronDown, ChevronRight, Loader2, MessageSquare, Pause, Play, Plus, ShieldAlert, Trash2 } from "lucide-react";
import {
  creerTache,
  decrireRythme,
  listerAgentsPossibles,
  joursSemaine,
  lancerTache,
  listerTaches,
  modifierTache,
  supprimerTache,
  type AgentPossible,
  type Rythme,
  type TacheProgrammee,
} from "@/lib/tachesProgrammees";
import { createSession, updateSession } from "@/lib/store/sessions";
import { newId } from "@/lib/store/storage";
import { currentUser } from "@/lib/store/identity";
import { Button } from "@/components/ui/Button";
import { Field, Input } from "@/components/ui/Field";
import { InfoBox } from "@/components/ui/InfoBox";
import { formaterDate } from "@/lib/formats";
import { locale, t, tf } from "@/lib/i18n";

/**
 * Les tâches programmées : une consigne, un rythme, et l'instance l'exécute
 * avec les outils de la personne, fenêtre fermée ou non
 * (gateway/src/tachesProgrammees.ts). Demandé par Medhi le 26/09/2026,
 * « comme le fait Claude ». Elles se créent ici, ou depuis un Chat
 * (« tous les lundis à 8 h, résume mes mails »), après une carte d'accord.
 */

type TypeRythme = Rythme["type"];

const vide = { titre: "", consigne: "", type: "jour" as TypeRythme, jourSemaine: 1, jourMois: 1, heure: "08:00", outils: true, agentId: "" };

function rythmeDe(f: typeof vide): Rythme {
  if (f.type === "semaine") return { type: "semaine", jour: f.jourSemaine };
  if (f.type === "mois") return { type: "mois", jour: f.jourMois };
  return { type: f.type } as Rythme;
}

const quandLisible = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleString(locale(), { weekday: "long", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" });
};


/** Qui fait la tâche : l'agent du Chat, ou l'un des agents de la personne. */
function ChoixAgent({ agents, valeur, onChange, disabled, compact }: { agents: AgentPossible[]; valeur: string; onChange: (id: string) => void; disabled?: boolean; compact?: boolean }) {
  // Un agent qu'on ne voit plus reste nommé tel quel : l'écran ne fait pas croire que la tâche a changé de mains.
  const inconnu = valeur && !agents.some((a) => a.id === valeur);
  return (
    <Select
      className={compact ? "w-[200px]" : "min-w-[180px]"}
      value={valeur}
      disabled={disabled}
      onChange={onChange}
      options={[
        { value: "", label: t("Agent du Chat") },
        ...agents.map((a) => ({ value: a.id, label: a.nom })),
        ...(inconnu ? [{ value: valeur, label: t("Agent introuvable") }] : []),
      ]}
    />
  );
}

export function TachesProgrammees() {
  const navigate = useNavigate();
  const [taches, setTaches] = useState<TacheProgrammee[] | null>(null);
  const [erreur, setErreur] = useState<string | null>(null);
  const [formulaire, setFormulaire] = useState<typeof vide | null>(null);
  const [enCours, setEnCours] = useState<string | null>(null);
  const [ouverte, setOuverte] = useState<string | null>(null);
  /** Les agents personnalisés (écran Agents) qu'on peut charger d'une tâche. */
  const [agents, setAgents] = useState<AgentPossible[]>([]);

  const relire = useCallback(async () => {
    const r = await listerTaches();
    // L'erreur d'une action reste affichée : la relecture qui suit ne l'efface plus (revue du 27/09/2026).
    if (r.ok) setTaches(r.valeur.taches);
    else setErreur(r.message);
  }, []);

  useEffect(() => {
    void listerAgentsPossibles().then((r) => r.ok && setAgents(r.valeur.agents));
  }, []);

  useEffect(() => {
    void relire();
    const minuterie = setInterval(() => void relire(), 20_000);
    return () => clearInterval(minuterie);
  }, [relire]);

  const enregistrer = async () => {
    if (!formulaire) return;
    setErreur(null);
    setEnCours("creation");
    const r = await creerTache({ titre: formulaire.titre, consigne: formulaire.consigne, rythme: rythmeDe(formulaire), heure: formulaire.heure, outils: formulaire.outils, ...(formulaire.agentId ? { agentId: formulaire.agentId } : {}) });
    setEnCours(null);
    if (!r.ok) return setErreur(r.message);
    setFormulaire(null);
    await relire();
  };

  const action = async (id: string, fn: () => Promise<{ ok: boolean; message?: string }>) => {
    setErreur(null);
    setEnCours(id);
    const r = (await fn()) as { ok: boolean; message?: string };
    setEnCours(null);
    if (!r.ok) setErreur(r.message ?? t("La demande a échoué."));
    await relire();
  };

  /** Le compte rendu dans un Chat, pour y répondre ou poursuivre. */
  const ouvrirDansUnChat = (x: TacheProgrammee) => {
    const moi = currentUser();
    const derniere = x.executions[0];
    if (!moi || !derniere) return;
    const s = createSession({ owner: moi, title: x.titre, origin: "local" });
    updateSession(s.id, {
      messages: [
        { id: newId(), role: "user", content: `${x.titre}\n\n${x.consigne}`, createdAt: derniere.quand },
        { id: newId(), role: "assistant", content: derniere.resultat, createdAt: derniere.quand },
      ],
    });
    navigate(`/?c=${s.id}`);
  };

  return (
    <div className="flex min-w-0 flex-1 flex-col overflow-y-auto">
      <div className="flex items-start justify-between gap-4 px-6 pb-3 pt-6">
        <div className="min-w-0">
          <h1 className="truncate text-xl font-semibold tracking-tight text-foreground">{t("Tâches programmées")}</h1>
          <p className="text-sm text-muted-foreground">
            {t("Une consigne et un rythme : l'instance les exécute avec vos outils, même fenêtre fermée. Vous pouvez aussi les demander dans un Chat.")}
          </p>
        </div>
        {!formulaire && (
          <Button icon={Plus} onClick={() => setFormulaire({ ...vide })}>
            {t("Nouvelle tâche programmée")}
          </Button>
        )}
      </div>

      <div className="space-y-3 px-6 pb-8">
        {erreur && (
          <InfoBox tone="warning" leading={<ShieldAlert size={15} strokeWidth={1.75} />}>
            {erreur}
          </InfoBox>
        )}

        {formulaire && (
          <div className="space-y-3 rounded-2xl border border-border bg-card p-4">
            <Field label={t("Titre")}>
              <Input value={formulaire.titre} onChange={(e) => setFormulaire({ ...formulaire, titre: e.target.value })} placeholder={t("Revue des mails du lundi")} />
            </Field>
            <Field label={t("Consigne")} hint={t("Ce que OxoAI doit faire à chaque fois, aussi précisément qu'à un collègue.")}>
              <textarea
                className="min-h-[88px] w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground"
                value={formulaire.consigne}
                onChange={(e) => setFormulaire({ ...formulaire, consigne: e.target.value })}
                placeholder={t("Résume mes mails de la semaine en signalant ceux qui attendent une réponse, puis liste mes rendez-vous des sept prochains jours.")}
              />
            </Field>
            <div className="flex flex-wrap items-end gap-3">
              <Field label={t("Rythme")}>
                <Select
                  className="min-w-[190px]"
                  value={formulaire.type}
                  onChange={(v) => setFormulaire({ ...formulaire, type: v as TypeRythme })}
                  options={[
                    { value: "jour", label: t("Chaque jour") },
                    { value: "jours-ouvres", label: t("Du lundi au vendredi") },
                    { value: "semaine", label: t("Chaque semaine") },
                    { value: "mois", label: t("Chaque mois") },
                  ]}
                />
              </Field>
              {formulaire.type === "semaine" && (
                <Field label={t("Jour")}>
                  <Select
                    className="min-w-[140px]"
                    value={String(formulaire.jourSemaine)}
                    onChange={(v) => setFormulaire({ ...formulaire, jourSemaine: Number(v) })}
                    options={[1, 2, 3, 4, 5, 6, 0].map((j) => ({ value: String(j), label: joursSemaine()[j] ?? "" }))}
                  />
                </Field>
              )}
              {formulaire.type === "mois" && (
                <Field label={t("Jour du mois")}>
                  <Select
                    className="min-w-[150px]"
                    value={String(formulaire.jourMois)}
                    onChange={(v) => setFormulaire({ ...formulaire, jourMois: Number(v) })}
                    options={[...Array.from({ length: 31 }, (_, k) => ({ value: String(k + 1), label: tf("Le {0}", String(k + 1)) })), { value: "-1", label: t("Le dernier jour") }]}
                  />
                </Field>
              )}
              <Field label={t("Heure")}>
                <Input type="time" value={formulaire.heure} onChange={(e) => setFormulaire({ ...formulaire, heure: e.target.value })} />
              </Field>
              <Field label={t("Fait par")}>
                <ChoixAgent agents={agents} valeur={formulaire.agentId} onChange={(agentId) => setFormulaire({ ...formulaire, agentId })} />
              </Field>
            </div>
            {agents.length === 0 && (
              <p className="text-xs text-muted-foreground">{t("Pour confier la tâche à un agent qui a ses propres instructions, créez-le d'abord dans l'écran Agents.")}</p>
            )}
            <label className="flex items-start gap-2 text-sm text-foreground">
              <input type="checkbox" className="mt-1" checked={formulaire.outils} onChange={(e) => setFormulaire({ ...formulaire, outils: e.target.checked })} />
              <span>
                {t("Avec mes outils (courrier, agenda, fichiers…).")}{" "}
                <span className="text-muted-foreground">{t("Ce qui modifie quelque chose attend votre accord, sauf au niveau « Tout approuver ».")}</span>
              </span>
            </label>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={() => setFormulaire(null)}>
                {t("Annuler")}
              </Button>
              <Button size="sm" icon={enCours === "creation" ? Loader2 : Check} disabled={enCours === "creation" || !formulaire.titre.trim() || !formulaire.consigne.trim()} onClick={() => void enregistrer()}>
                {t("Programmer")}
              </Button>
            </div>
          </div>
        )}

        {taches === null && !erreur && (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 size={15} className="animate-spin" /> {t("Lecture des tâches programmées…")}
          </p>
        )}

        {taches && taches.length === 0 && !formulaire && (
          <div className="rounded-2xl border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
            <CalendarClock size={20} strokeWidth={1.75} className="mx-auto mb-2" />
            {t("Aucune tâche programmée. Créez-en une, ou demandez-la dans un Chat : « Tous les lundis à 8 h, résume mes mails de la semaine ».")}
          </div>
        )}

        {taches?.map((x) => {
          const derniere = x.executions[0];
          const deplie = ouverte === x.id;
          return (
            <div key={x.id} className="rounded-2xl border border-border bg-card p-4">
              <div className="flex flex-wrap items-start gap-3">
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-info/10 text-info">
                  <CalendarClock size={17} strokeWidth={1.75} />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-foreground">
                    {x.titre}
                    {!x.active && <span className="ms-2 text-xs text-muted-foreground">{t("en pause")}</span>}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {decrireRythme(x.rythme, x.heure)}
                    {x.active ? ` · ${tf("prochaine fois : {0}", quandLisible(x.prochaine))}` : ""}
                  </p>
                  <div className="mt-1.5 flex items-center gap-1.5 text-xs text-muted-foreground">
                    <Bot size={13} strokeWidth={1.75} className="shrink-0" />
                    <span className="shrink-0">{t("Fait par")}</span>
                    <ChoixAgent
                      compact
                      agents={agents}
                      valeur={x.agentId ?? ""}
                      disabled={Boolean(enCours) || x.enCours}
                      onChange={(agentId) => void action(x.id, () => modifierTache(x.id, { agentId: agentId || null }))}
                    />
                  </div>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  <Button variant="ghost" size="sm" icon={enCours === x.id || x.enCours ? Loader2 : Play} disabled={Boolean(enCours) || x.enCours} onClick={() => void action(x.id, () => lancerTache(x.id))}>
                    {x.enCours ? t("En cours…") : t("Lancer maintenant")}
                  </Button>
                  <Button variant="ghost" size="sm" icon={x.active ? Pause : Play} disabled={Boolean(enCours)} onClick={() => void action(x.id, () => modifierTache(x.id, { active: !x.active }))}>
                    {x.active ? t("Mettre en pause") : t("Reprendre")}
                  </Button>
                  <Button variant="ghost" size="sm" icon={Trash2} disabled={Boolean(enCours)} onClick={() => void action(x.id, () => supprimerTache(x.id))}>
                    {t("Supprimer")}
                  </Button>
                </div>
              </div>
              {derniere && (
                <div className="mt-3 border-t border-border pt-3">
                  <button type="button" className="flex w-full items-center gap-1.5 text-start text-xs text-muted-foreground" onClick={() => setOuverte(deplie ? null : x.id)}>
                    {deplie ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                    {derniere.ok ? tf("Dernier compte rendu, le {0}", formaterDate(new Date(derniere.quand))) : tf("Dernière exécution en échec, le {0}", formaterDate(new Date(derniere.quand)))}
                    {derniere.agent ? ` · ${derniere.agent}` : ""}
                  </button>
                  {deplie && (
                    <div className="mt-2 space-y-2">
                      <p className="whitespace-pre-wrap text-sm text-foreground">{derniere.resultat}</p>
                      <Button variant="secondary" size="sm" icon={MessageSquare} onClick={() => ouvrirDansUnChat(x)}>
                        {t("Ouvrir dans un Chat")}
                      </Button>
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
