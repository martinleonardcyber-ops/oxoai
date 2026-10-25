import { useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { FolderOpen, Loader2, Terminal, X } from "lucide-react";
import { cn } from "@/lib/cn";
import { parDossier, useSessionsCode } from "@/hooks/useSessionsCode";
import { sessionCodeEnCours } from "@/hooks/useCode";
import { dateCourte, nomDossier, type SessionCodeResume } from "@/lib/code";
import { t, tf } from "@/lib/i18n";

/**
 * Les sessions de OxoAI Code, séparées des Chats (demandé par Medhi le
 * 25/09/2026, « comme dans Claude Code »). Dans la barre latérale en mode
 * Code, à la place de la liste des Chats, rangées par dossier de projet ; et
 * sur l'accueil de Code, les plus récentes. Chaque ligne rouvre sa session
 * (`/code?s=<id>`), avec son historique relu chez l'agent de code.
 */

function LigneSessionCode({
  session,
  actif,
  onRetirer,
}: {
  session: SessionCodeResume;
  actif: boolean;
  onRetirer: () => void;
}) {
  const navigate = useNavigate();
  const titre = session.titre || t("Session sans demande");
  /*
   * L'agent y travaille encore (27/09/2026) : vu de cet écran (session quittée
   * en plein travail) ou dit par l'instance (ouverte ailleurs, OxoAI qui
   * prépare ou contrôle). Comme la roue d'un Chat qui écrit encore.
   */
  const enCours = Boolean(session.enCours) || sessionCodeEnCours(session.id);
  return (
    <li className="group relative">
      <button
        type="button"
        onClick={() => navigate(`/code?s=${encodeURIComponent(session.id)}`)}
        title={titre}
        aria-current={actif ? "page" : undefined}
        className={cn(
          "flex w-full items-center gap-2 rounded-lg px-2 py-1.5 pe-7 text-start text-sm transition-colors",
          actif ? "bg-muted font-medium text-foreground" : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
        )}
      >
        <span className="min-w-0 flex-1 truncate">{titre}</span>
        {enCours ? (
          <Loader2
            size={13}
            strokeWidth={1.75}
            className="shrink-0 animate-spin text-primary"
            aria-label={t("En cours")}
          />
        ) : (
          <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">{dateCourte(session.maj)}</span>
        )}
      </button>
      {/*
        Pas de retrait pendant que l'agent travaille (27/09/2026) : la session
        quittait l'écran et la liste, et l'agent continuait sans que personne
        puisse le suivre ni l'arrêter. On l'arrête d'abord, depuis la session.
      */}
      {!enCours && (
        <button
          type="button"
          onClick={onRetirer}
          aria-label={tf("Retirer « {0} » de la liste", titre)}
          title={t("Retirer de la liste (la session reste chez l'agent de code)")}
          className="absolute end-1 top-1/2 hidden h-6 w-6 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground group-hover:flex focus-visible:flex"
        >
          <X size={13} strokeWidth={1.75} />
        </button>
      )}
    </li>
  );
}

/** Liste de la barre latérale en mode Code : groupées par dossier, la plus récente d'abord. */
export function SessionsCodeListe({ recherche = "" }: { recherche?: string }) {
  const { sessions, charge, erreur, retirer } = useSessionsCode();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const active = params.get("s");
  const terme = recherche.trim().toLowerCase();
  const visibles = terme
    ? sessions.filter((s) => s.titre.toLowerCase().includes(terme) || s.dossier.toLowerCase().includes(terme))
    : sessions;
  const [retraitEchoue, setRetraitEchoue] = useState(false);

  const retirerSession = async (s: SessionCodeResume) => {
    const ok = await retirer(s.id).catch(() => false);
    setRetraitEchoue(!ok);
    if (ok && s.id === active) navigate("/code");
  };

  if (charge && sessions.length === 0) {
    return (
      <div className="flex min-h-[140px] flex-1 flex-col items-center justify-center gap-3 px-8 py-6 text-center">
        <span className="flex h-12 w-12 items-center justify-center rounded-full bg-muted">
          <Terminal size={20} strokeWidth={1.75} className="text-muted-foreground" />
        </span>
        <p className="text-xs leading-relaxed text-muted-foreground">
          {erreur ?? t("Vos sessions de Code apparaîtront ici, rangées par dossier de projet.")}
        </p>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto px-3 pt-3">
      <p className="px-1 pb-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        {t("Sessions de Code")}
      </p>
      {erreur && <p className="px-1 pb-2 text-xs text-warning">{erreur}</p>}
      {retraitEchoue && <p className="px-1 pb-2 text-xs text-warning">{t("La session n'a pas pu être retirée de la liste.")}</p>}
      {terme && visibles.length === 0 && (
        <p className="px-1 pb-2 text-xs text-muted-foreground">{t("Aucune session ne correspond à votre recherche.")}</p>
      )}
      {parDossier(visibles).map((groupe) => (
        <div key={groupe.dossier} className="pb-2">
          <p className="flex items-center gap-1.5 px-1 pb-0.5 pt-1 text-xs font-medium text-foreground" title={groupe.dossier}>
            <FolderOpen size={13} strokeWidth={1.75} className="shrink-0 text-muted-foreground" />
            <span className="truncate">{nomDossier(groupe.dossier)}</span>
          </p>
          <ul className="space-y-0.5">
            {groupe.sessions.map((s) => (
              <LigneSessionCode key={s.id} session={s} actif={s.id === active} onRetirer={() => void retirerSession(s)} />
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}
