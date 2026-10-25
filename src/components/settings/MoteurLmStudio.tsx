import { useCallback, useEffect, useState } from "react";
import { AppWindow, Check, Loader2, MonitorOff, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { InfoBox } from "@/components/ui/InfoBox";
import { branding } from "@/config/branding";
import { apiFetch } from "@/lib/endpoint";
import { cn } from "@/lib/cn";
import { t, tf } from "@/lib/i18n";

/**
 * Le moteur de LM Studio que l'instance a le droit de démarrer (23/10/2026,
 * gateway/src/reglagesMoteur.ts). Signalé par une utilisatrice : « à chaque
 * fois que je l'utilise, il ouvre automatiquement Bionic ». Quand seule
 * l'application LM Studio est déclarée sur la machine, la démarrer peut
 * l'afficher, ou afficher Bionic ; l'instance ne le fait plus sans que la
 * personne l'ait choisi.
 *
 * Montré dans Réglages, Modèles locaux, et à la mise en route quand
 * l'application est fermée et que rien n'est choisi (FirstRun.tsx).
 */

interface EtatMoteur {
  concerne: boolean;
  choix?: "application" | "sansFenetre" | null;
  applicationDeclaree?: boolean;
  llmsterDeclare?: boolean;
  serviceEcoute?: boolean;
  admin: boolean;
}

const refus = async (r: Response) =>
  ((await r.json().catch(() => ({}))) as { error?: { message?: string } }).error?.message ?? tf("Demande refusée ({0}).", r.status);

export function MoteurLmStudio({ onChange, miseEnRoute = false }: { onChange?: () => void; miseEnRoute?: boolean }) {
  const [etat, setEtat] = useState<EtatMoteur | null>(null);
  const [erreur, setErreur] = useState<string | null>(null);
  const [occupe, setOccupe] = useState(false);
  const [conditions, setConditions] = useState(false);
  /** L'installation du moteur sans fenêtre en cours : le message de la passerelle. */
  const [suivi, setSuivi] = useState<{ phase: string; message: string; error?: string } | null>(null);

  const charger = useCallback(() => {
    void apiFetch("/oxoai/moteur-lmstudio")
      .then(async (r) => (r.ok ? ((await r.json()) as EtatMoteur) : Promise.reject(new Error(await refus(r)))))
      .then(setEtat)
      .catch((err: unknown) => setErreur(err instanceof Error ? err.message : String(err)));
  }, []);
  useEffect(charger, [charger]);

  // L'installation se suit en relisant l'état de la mise en route, toutes les deux secondes.
  const enCours = suivi !== null && !["ready", "error"].includes(suivi.phase);
  useEffect(() => {
    if (!enCours) return;
    const id = window.setInterval(() => {
      void apiFetch("/oxoai/provision")
        .then((r) => (r.ok ? r.json() : null))
        .then((d: { state?: { phase: string; message: string; error?: string } } | null) => {
          if (!d?.state) return;
          setSuivi(d.state);
          if (d.state.phase === "ready" || d.state.phase === "error") {
            charger();
            onChange?.();
          }
        })
        .catch(() => undefined);
    }, 2000);
    return () => window.clearInterval(id);
  }, [enCours, charger, onChange]);

  if (!etat) {
    return erreur && !miseEnRoute ? (
      <InfoBox tone="warning" leading={<TriangleAlert size={15} strokeWidth={1.75} />}>
        {erreur}
      </InfoBox>
    ) : null;
  }
  // Rien à choisir : pas de LM Studio sur cette instance, ou pas d'application LM Studio à côté du moteur de l'instance.
  if (!etat.concerne || !etat.applicationDeclaree) return null;

  const enPlace = etat.llmsterDeclare === true;

  const choisir = async (choix: "application" | "sansFenetre") => {
    setOccupe(true);
    setErreur(null);
    try {
      const r = await apiFetch("/oxoai/moteur-lmstudio", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ choix }),
      });
      if (!r.ok) throw new Error(await refus(r));
      // Le moteur sans fenêtre n'est pas encore posé : la route d'installation, conditions acceptées, sans enchaîner sur un modèle.
      if (choix === "sansFenetre" && !enPlace) {
        const i = await apiFetch("/oxoai/provision/moteur", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ conditionsAcceptees: true, sansModele: true }),
        });
        if (!i.ok && i.status !== 409) throw new Error(await refus(i));
        setSuivi({ phase: "downloading", message: t("Préparation du téléchargement...") });
      }
      charger();
      onChange?.();
    } catch (err) {
      setErreur(err instanceof Error ? err.message : String(err));
    } finally {
      setOccupe(false);
    }
  };

  return (
    <div className={cn("space-y-3 text-start", miseEnRoute && "w-full max-w-md")}>
      {!miseEnRoute && <p className="text-sm font-medium text-foreground">{t("Moteur des modèles locaux")}</p>}
      <p className="text-sm leading-relaxed text-muted-foreground">
        {tf("L'application LM Studio est installée sur cette machine. Quand elle est fermée, la démarrer peut l'afficher, ou ouvrir Bionic, l'application d'agent du même éditeur. {0} n'a besoin ni de l'une ni de l'autre à l'écran, et les modèles locaux qu'il utilise ne consomment aucun crédit : aucun abonnement n'est nécessaire.", branding.name)}
      </p>

      {etat.serviceEcoute && (
        <p className="flex items-center gap-2 text-sm text-foreground">
          <Check size={15} strokeWidth={2.5} className="shrink-0 text-success" />
          {tf("LM Studio tourne : {0} s'y branche sans rien démarrer.", branding.name)}
        </p>
      )}

      {enPlace && etat.choix === "sansFenetre" ? (
        <p className="flex items-center gap-2 text-sm text-foreground">
          <MonitorOff size={15} strokeWidth={1.75} className="shrink-0 text-muted-foreground" />
          {tf("Le moteur sans fenêtre est en place : {0} le démarre sans rien ouvrir.", branding.name)}
        </p>
      ) : (
        <>
          {etat.choix === null && !etat.serviceEcoute && (
            <p className="text-sm text-muted-foreground">
              {tf("Tant que rien n'est choisi, {0} se branche sur LM Studio quand vous l'ouvrez, et ne le démarre jamais lui-même.", branding.name)}
            </p>
          )}

          <div className="grid gap-2">
            <div className={cn("rounded-xl border p-3", etat.choix === "sansFenetre" ? "border-primary bg-muted" : "border-border")}>
              <p className="flex items-center gap-2 text-sm font-medium text-foreground">
                <MonitorOff size={15} strokeWidth={1.75} className="shrink-0" />
                {tf("Moteur sans fenêtre de {0}", branding.name)}
              </p>
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                {tf("{0} pose à côté le moteur sans interface de LM Studio (llmster, de 0,3 à 1,3 Go selon le système) et le démarre quand il en a besoin, sans rien ouvrir. Il utilise le même dossier que LM Studio. Ensuite, l'outil lms de LM Studio démarre lui aussi ce moteur quand rien ne tourne.", branding.name)}
              </p>
              {etat.admin && (
                <>
                  <label className="mt-2 flex items-start gap-2 text-xs text-foreground">
                    <input type="checkbox" className="mt-0.5" checked={conditions} onChange={(e) => setConditions(e.target.checked)} />
                    <span>
                      {t("J'accepte, pour moi ou au nom de mon organisation, les")}{" "}
                      <a href="https://lmstudio.ai/app-terms" target="_blank" rel="noreferrer noopener" className="underline underline-offset-2">
                        {t("conditions d'utilisation de LM Studio")}
                      </a>
                      {t(", qui en permettent l'usage personnel et interne, pas un service fourni à d'autres.")}
                    </span>
                  </label>
                  <Button className="mt-2" size="sm" icon={MonitorOff} disabled={occupe || enCours || !conditions} onClick={() => void choisir("sansFenetre")}>
                    {t("Installer le moteur sans fenêtre")}
                  </Button>
                </>
              )}
            </div>

            <div className={cn("rounded-xl border p-3", etat.choix === "application" ? "border-primary bg-muted" : "border-border")}>
              <p className="flex items-center gap-2 text-sm font-medium text-foreground">
                <AppWindow size={15} strokeWidth={1.75} className="shrink-0" />
                {t("Application LM Studio")}
              </p>
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                {tf("{0} démarre le service de l'application quand il en a besoin. LM Studio ou Bionic peut alors s'ouvrir. Pour l'éviter : dans LM Studio, Réglages (Cmd ou Ctrl et la virgule), cochez « Run LLM server on login » ; le service tourne alors en arrière-plan dès l'ouverture de votre session, et {0} s'y branche sans rien démarrer.", branding.name)}
              </p>
              {etat.admin && etat.choix !== "application" && (
                <Button className="mt-2" size="sm" variant="ghost" icon={AppWindow} disabled={occupe || enCours} onClick={() => void choisir("application")}>
                  {tf("Laisser {0} démarrer LM Studio", branding.name)}
                </Button>
              )}
            </div>
          </div>

          {!etat.admin && <p className="text-xs text-muted-foreground">{t("Seul l'administrateur de l'instance choisit le moteur des modèles locaux.")}</p>}
        </>
      )}

      {suivi && (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          {enCours ? <Loader2 size={15} className="shrink-0 animate-spin" /> : suivi.phase === "ready" ? <Check size={15} strokeWidth={2.5} className="shrink-0 text-success" /> : <TriangleAlert size={15} strokeWidth={1.75} className="shrink-0" />}
          <span>
            {suivi.message}
            {suivi.error ? ` ${suivi.error}` : ""}
          </span>
        </p>
      )}

      {erreur && (
        <InfoBox tone="warning" leading={<TriangleAlert size={15} strokeWidth={1.75} />}>
          {erreur}
        </InfoBox>
      )}
    </div>
  );
}

export default MoteurLmStudio;
