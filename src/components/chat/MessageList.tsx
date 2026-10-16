import { useEffect, useRef, useState } from "react";
import {
  ChevronDown,
  TriangleAlert,
  Brain,
  Wrench,
  Loader2,
  Check,
  Circle,
  ListTree,
  Download,
  FileText,
  BookOpenText,
  Timer,
  Globe,
  ExternalLink,
  Scissors,
  History,
} from "lucide-react";
import { dureeCourte, dureeMesuree, useMaintenant } from "@/lib/durees";
import type { Citation } from "@/lib/connaissances";
import { LogoMark } from "@/components/ui/Logo";
import { Avatar } from "@/components/ui/Avatar";
import { PiecesJointesMessage } from "./PiecesJointesMessage";
import { cn } from "@/lib/cn";
import type { DureesReponse, EtapePlan, Message, ToolTrace } from "@/hooks/useChat";
import { TexteRiche } from "@/components/ui/TexteRiche";
import { urlImage, type ImageCreee } from "@/lib/images";
import { cibleAffichee, libelleOutil } from "@/lib/libellesOutils";
import { lienSur, siteDe, type SourceWeb } from "@/lib/rechercheWeb";
import { t, tf } from "@/lib/i18n";

/**
 * Bloc de raisonnement repliable (modèles à canal de réflexion séparé).
 *
 * Avec sa durée depuis le 27/09/2026, comme ailleurs (« Réflexion : 12 s ») :
 * un compteur qui avance tant que le modèle réfléchit, puis le temps qu'il y a
 * passé, toutes phases comprises. Une réponse d'avant, sans mesure, garde
 * l'ancien libellé : aucune durée n'est reconstituée.
 */
function Reasoning({ text, live, durees }: { text: string; live?: boolean; durees?: DureesReponse }) {
  const [open, setOpen] = useState(false);
  const enCours = durees?.reflexionDepuis !== undefined;
  const maintenant = useMaintenant(enCours);
  const ecoulee = enCours ? (durees.reflexion ?? 0) + Math.max(0, maintenant - durees.reflexionDepuis!) : durees?.reflexion;
  return (
    <div className="mb-2">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="inline-flex items-center gap-1.5 rounded-full bg-muted/70 px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
      >
        <Brain size={13} strokeWidth={1.75} />
        {live ? (
          <>
            {t("Réflexion en cours...")}
            {ecoulee !== undefined && <span className="tabular-nums opacity-70">{dureeCourte(ecoulee)}</span>}
          </>
        ) : ecoulee ? (
          tf("Réflexion : {0}", dureeMesuree(ecoulee))
        ) : (
          t("Réflexion")
        )}
        <ChevronDown
          size={12}
          strokeWidth={2}
          className={cn("transition-transform", open && "rotate-180")}
        />
      </button>
      {open && (
        <p dir="auto" className="mt-1.5 whitespace-pre-wrap border-s-2 border-border ps-3 text-xs leading-relaxed text-muted-foreground">
          {text}
        </p>
      )}
    </div>
  );
}


/**
 * Plan suivi par l'agent sur une demande lourde.
 *
 * Une tâche découpée peut occuper plusieurs minutes. Sans cette liste,
 * l'utilisateur n'a devant lui qu'un curseur qui clignote : il ne sait ni ce
 * que l'agent est en train de faire, ni combien il reste, ni si c'est bloqué.
 * Ce n'est pas de l'ornement, c'est ce qui rend l'attente supportable.
 */
/**
 * Retire les lignes de contrôle que la passerelle demande au modèle
 * (« VERIFIE : TOUT EST FAIT », « VERIFIE : INCOMPLET… », « RIEN A FAIRE »).
 * Elles servent à la passerelle pour trancher, pas à la personne : un petit
 * modèle les recopie parfois en plein texte, collées à une phrase. Retirées à
 * l'affichage, donc aussi pendant que la réponse s'écrit.
 */
function sansMarqueursInternes(texte: string): string {
  return texte
    /*
     * Réflexion restée dans le texte : un moteur qui ne la sépare pas (réglage
     * de LM Studio, service compatible OpenAI) la livre entre balises dans la
     * réponse. Retirée, y compris ouverte et pas encore refermée pendant
     * l'écriture ; l'interrupteur « /no_think » recopié l'est aussi.
     */
    .replace(/<think>[\s\S]*?(?:<\/think>\s*|$)/g, "")
    .replace(/[ \t]*\/no_think\b/g, "")
    .replace(/[ \t]*V[ÉE]RIFI[ÉE][ \t]*:[ \t]*(?:TOUT EST FAIT|INCOMPLET)[^\n]*/gi, "")
    .replace(/^[ \t]*RIEN A FAIRE[ \t]*$/gim, "")
    .replace(/\n{3,}/g, "\n\n");
}

function PlanSuivi({ etapes, revue }: { etapes: EtapePlan[]; revue?: "encours" | "fait" | "incomplet" }) {
  // Une étape redécoupée ne compte pas : ce sont ses parties qui se font.
  const aFaire = etapes.filter((e) => e.etat !== "decoupee");
  const faites = aFaire.filter((e) => e.etat === "fait").length;

  return (
    <div className="mb-2.5 rounded-xl border border-border bg-muted/40 px-3 py-2.5">
      <p className="mb-2 text-xs font-medium text-muted-foreground">
        {t("Plan de travail :")}{" "}
        {/* Deux appels écrits en entier : un modèle choisi par une condition échappait au relevé (i18n.mjs), donc à la traduction. */}
        {faites > 1 ? tf("{0} étapes faites sur {1}", faites, aFaire.length) : tf("{0} étape faite sur {1}", faites, aFaire.length)}
      </p>
      <ol className="space-y-1.5">
        {etapes.map((e, i) => (
          <li
            key={e.chemin ?? i}
            className="flex items-start gap-2 text-xs leading-relaxed"
            style={{ paddingInlineStart: `${(e.profondeur ?? 0) * 1.1}rem` }}
          >
            {e.etat === "decoupee" ? (
              <ListTree size={12} strokeWidth={1.75} className="mt-0.5 shrink-0 text-muted-foreground" />
            ) : e.etat === "encours" ? (
              <Loader2 size={12} className="mt-0.5 shrink-0 animate-spin text-foreground" />
            ) : e.etat === "fait" ? (
              <Check size={12} strokeWidth={2.5} className="mt-0.5 shrink-0 text-success" />
            ) : e.etat === "echec" ? (
              <TriangleAlert size={12} strokeWidth={2} className="mt-0.5 shrink-0 text-destructive" />
            ) : (
              <Circle size={12} strokeWidth={1.75} className="mt-0.5 shrink-0 text-muted-foreground/50" />
            )}
            <span
              className={cn(
                e.etat === "attente" && "text-muted-foreground/70",
                e.etat === "encours" && "text-foreground",
                e.etat === "fait" && "text-muted-foreground",
                e.etat === "echec" && "text-foreground",
              )}
            >
              {e.titre}
              {e.reprise && (
                <span className="text-muted-foreground/70">{" "}{t("(redemandée)")}</span>
              )}
              {e.controlee && e.etat !== "decoupee" && (
                <span className="text-muted-foreground/70">{" "}{t("(contrôlée)")}</span>
              )}
              {e.etat === "decoupee" && (
                <span className="text-muted-foreground/70">{" "}{t("(trop grosse : découpée en parties)")}</span>
              )}
            </span>
          </li>
        ))}
      </ol>
      {revue && (
        <p className="mt-2 flex items-center gap-2 border-t border-border pt-2 text-xs text-muted-foreground">
          {revue === "encours" ? (
            <Loader2 size={12} className="shrink-0 animate-spin text-foreground" />
          ) : revue === "fait" ? (
            <Check size={12} strokeWidth={2.5} className="shrink-0 text-success" />
          ) : (
            <TriangleAlert size={12} strokeWidth={2} className="shrink-0 text-warning" />
          )}
          {revue === "encours"
            ? t("Revue finale : la demande entière est relue contre le résultat réel...")
            : revue === "fait"
              ? t("Revue finale : rien ne manque.")
              : t("Revue finale : des manques ont été trouvés, et des compléments ajoutés.")}
        </p>
      )}
    </div>
  );
}

/**
 * Activité des outils MCP pendant la réponse.
 *
 * Chaque étape dit son temps depuis le 27/09/2026 : celui qui passe tant
 * qu'elle tourne, puis ce qu'elle a duré. Une recherche web de 40 s ne se
 * confond plus avec une lecture de fichier instantanée.
 */
function ToolTraces({ traces }: { traces: ToolTrace[] }) {
  /*
   * L'index de la trace ouverte, et non un simple booleen : partage entre
   * toutes les traces, il depliait les apercus de tous les outils d'un coup
   * des qu'on cliquait sur l'un d'eux.
   */
  const [ouverte, setOuverte] = useState<number | null>(null);
  const maintenant = useMaintenant(traces.some((trace) => trace.running && trace.debut !== undefined));
  return (
    <div className="mb-2 space-y-1">
      {traces.map((t, i) => {
        const detail = t.cible ?? (t.libelle ? null : cibleAffichee(t.args));
        const open = ouverte === i;
        const duree = t.running
          ? t.debut !== undefined
            ? dureeCourte(Math.max(0, maintenant - t.debut))
            : null
          : t.duree !== undefined
            ? dureeMesuree(t.duree)
            : null;
        return (
          <div key={`${t.name}-${i}`} className="text-xs">
            <button
              type="button"
              aria-expanded={open}
              onClick={() => setOuverte(open ? null : i)}
              className="inline-flex max-w-full items-center gap-1.5 rounded-full bg-muted/70 px-2.5 py-1 text-muted-foreground transition-colors hover:text-foreground"
            >
              {t.running ? (
                <Loader2 size={12} className="shrink-0 animate-spin" />
              ) : t.ok ? (
                <Check size={12} strokeWidth={2.5} className="shrink-0 text-success" />
              ) : (
                <TriangleAlert size={12} strokeWidth={2} className="shrink-0 text-destructive" />
              )}
              <Wrench size={11} strokeWidth={1.75} className="shrink-0" />
              <span className="truncate">
                {t.libelle ?? libelleOutil(t.name)}
                {detail && <span className="opacity-70"> · {detail}</span>}
              </span>
              {/* Hors de la partie tronquée : un long chemin ne doit pas cacher la durée. */}
              {duree && <span className="shrink-0 tabular-nums opacity-70">{duree}</span>}
            </button>
            {open && t.preview && (
              <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-words border-s-2 border-border ps-3 text-[11px] leading-relaxed text-muted-foreground">
                {t.preview}
              </pre>
            )}
          </div>
        );
      })}
    </div>
  );
}

/**
 * Une image créée sur la machine. Lue par la séance de la personne (l'image
 * est servie à son auteur et à qui voit le Chat où elle a été créée), gardée
 * en adresse locale le temps de l'affichage.
 */
function ImageGeneree({ image }: { image: ImageCreee }) {
  const [url, setUrl] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    let vivant = true;
    let adresse: string | null = null;
    void urlImage(image.id).then((u) => {
      adresse = u;
      if (vivant) setUrl(u);
      else if (u) URL.revokeObjectURL(u);
    });
    return () => {
      vivant = false;
      if (adresse) URL.revokeObjectURL(adresse);
    };
  }, [image.id]);
  const nom = `${image.description.slice(0, 40).replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/g, "") || (image.video ? "video" : "image")}.${image.video ? "webm" : "png"}`;
  return (
    <figure className="mt-3 w-full max-w-[460px]">
      <div
        className="overflow-hidden rounded-2xl border border-border bg-muted"
        style={{ aspectRatio: `${image.largeur} / ${image.hauteur}` }}
      >
        {url && image.video ? (
          // Une vidéo créée sur la machine (27/09/2026) : lue sur place, en boucle, comme un aperçu.
          <video src={url} controls loop playsInline className="h-full w-full object-cover" aria-label={image.description} />
        ) : url ? (
          <img src={url} alt={image.description} className="h-full w-full object-cover" />
        ) : (
          <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
            {url === null ? (image.video ? t("Vidéo indisponible sur ce poste.") : t("Image indisponible sur ce poste.")) : <Loader2 size={16} className="animate-spin" />}
          </div>
        )}
      </div>
      {url && (
        <a
          href={url}
          download={nom}
          className="mt-2 inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
        >
          <Download size={13} strokeWidth={1.75} />
          {t("Télécharger")}
        </a>
      )}
    </figure>
  );
}

/**
 * Citations des bases de connaissances, sous la réponse.
 *
 * Mis en avant : les passages que la réponse cite ([1], [2]...). Les autres
 * ont été donnés au modèle sans qu'il s'en serve : mesuré le 25/09/2026, la
 * recherche remonte toujours cinq passages, même pour une question à laquelle
 * aucun document ne répond (les scores de similarité se tassent entre 0,63 et
 * 0,80). Les afficher comme des sources ferait dire à l'écran que la réponse
 * vient de documents qui n'en parlent pas. Ils restent consultables, repliés,
 * et dits pour ce qu'ils sont.
 */
function Sources({ message }: { message: Message }) {
  const [ouverte, setOuverte] = useState<number | null>(null);
  const [autres, setAutres] = useState(false);
  const s = message.sources;
  if (!s) return null;
  const citesDansLeTexte = new Set([...message.content.matchAll(/\[(\d{1,2})\]/g)].map((m) => Number(m[1])));
  const citees = s.citations.filter((c) => citesDansLeTexte.has(c.n));
  const nonCitees = s.citations.filter((c) => !citesDansLeTexte.has(c.n));
  const ligne = (c: Citation) => (
    <div key={c.n} className="text-xs">
      <button
        type="button"
        aria-expanded={ouverte === c.n}
        onClick={() => setOuverte(ouverte === c.n ? null : c.n)}
        className="inline-flex max-w-full items-center gap-1.5 rounded-full bg-muted/70 px-2.5 py-1 text-muted-foreground transition-colors hover:text-foreground"
      >
        <FileText size={12} strokeWidth={1.75} className="shrink-0" />
        <span className="truncate">
          [{c.n}] {c.document}
          <span className="opacity-70"> · {c.base}</span>
        </span>
      </button>
      {ouverte === c.n && (
        <p className="mt-1 whitespace-pre-wrap border-s-2 border-border ps-3 text-[11px] leading-relaxed text-muted-foreground">
          {c.extrait}
          {c.extrait.length >= 600 ? "..." : ""}
        </p>
      )}
    </div>
  );
  return (
    <div className="mt-3 space-y-1.5">
      {citees.length > 0 && (
        <>
          <p className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
            <BookOpenText size={13} strokeWidth={1.75} />
            {t("Sources")}
          </p>
          {citees.map(ligne)}
        </>
      )}
      {!message.streaming && nonCitees.length > 0 && (
        <div>
          <button
            type="button"
            aria-expanded={autres}
            onClick={() => setAutres((a) => !a)}
            className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
          >
            {citees.length > 0
              ? tf("{0} autre(s) passage(s) consulté(s), non cité(s)", nonCitees.length)
              : tf("{0} passage(s) des bases de connaissances consulté(s), aucun cité par la réponse", nonCitees.length)}
            <ChevronDown size={12} strokeWidth={2} className={cn("transition-transform", autres && "rotate-180")} />
          </button>
          {autres && <div className="mt-1.5 space-y-1.5">{nonCitees.map(ligne)}</div>}
        </div>
      )}
      {s.citations.length === 0 && !s.erreur && (
        <p className="text-xs text-muted-foreground">{t("Bases de connaissances consultées : aucun passage ne s'approchait de la question.")}</p>
      )}
      {s.erreur && <p className="text-xs text-muted-foreground">{s.erreur}</p>}
      {(s.ignorees ?? 0) > 0 && (
        <p className="text-xs text-muted-foreground">
          {tf("{0} base(s) de connaissances ignorée(s) : vous n'y avez pas accès.", s.ignorees)}
        </p>
      )}
      {(s.aReindexer ?? 0) > 0 && (
        <p className="text-xs text-muted-foreground">
          {tf("{0} document(s) indexé(s) par un autre modèle que celui de la machine : ils n'ont pas été consultés. Réindexez la base.", s.aReindexer)}
        </p>
      )}
    </div>
  );
}

/**
 * Mémoire de la conversation, sous la réponse (16/10/2026,
 * gateway/src/memoireConversation.ts) : une ligne discrète, comme les
 * sources, qui dit combien d'extraits plus anciens de ce Chat ont été rendus
 * au modèle. Elle ne dit pas qu'il s'en est servi : seulement qu'il les avait.
 */
function MemoireUtilisee({ message }: { message: Message }) {
  const m = message.memoire;
  if (!m || m.extraits <= 0) return null;
  return (
    <p className="mt-3 flex items-center gap-1.5 text-xs text-muted-foreground">
      <History size={13} strokeWidth={1.75} className="shrink-0" />
      {m.autresChats
        ? tf("{0} extrait(s) plus ancien(s) de vos Chats rendu(s) à l'assistant, dont {1} d'un autre Chat", m.extraits, m.autresChats)
        : tf("{0} extrait(s) plus ancien(s) de ce Chat rendu(s) à l'assistant", m.extraits)}
    </p>
  );
}

/**
 * Sources de la recherche sur le web, sous la réponse (28/09/2026), sur le
 * modèle des citations des bases de connaissances : en avant, celles que la
 * réponse cite par leur numéro ([3]) ; les autres, repliées et dites pour ce
 * qu'elles sont. Un petit modèle oublie souvent les numéros : les pages
 * qu'il a ouvertes restent alors montrées, sous « Pages consultées », sans
 * les faire passer pour des citations.
 *
 * Chaque source est un lien vers la page, ouvert hors de l'application
 * (electron/main.cjs, `setWindowOpenHandler`), et seulement en http ou https.
 */
function SourcesWeb({ message }: { message: Message }) {
  const [autres, setAutres] = useState(false);
  const liste = message.sourcesWeb;
  if (!liste || liste.length === 0) return null;
  const citesDansLeTexte = new Set([...message.content.matchAll(/\[(\d{1,3})\]/g)].map((m) => Number(m[1])));
  const citees = liste.filter((s) => citesDansLeTexte.has(s.n));
  const enAvant = citees.length > 0 ? citees : liste.filter((s) => s.lue);
  const reste = liste.filter((s) => !enAvant.includes(s));
  const lien = (s: SourceWeb) => {
    const href = lienSur(s.adresse);
    const contenu = (
      <>
        <Globe size={12} strokeWidth={1.75} className="shrink-0" />
        <span className="truncate">
          [{s.n}] {s.titre}
          <span className="opacity-70"> · {siteDe(s.adresse)}</span>
        </span>
        {href && <ExternalLink size={11} strokeWidth={1.75} className="shrink-0 opacity-70" />}
      </>
    );
    const classe =
      "inline-flex max-w-full items-center gap-1.5 rounded-full bg-muted/70 px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:text-foreground";
    return href ? (
      <a key={s.n} href={href} target="_blank" rel="noreferrer noopener" title={s.adresse} className={classe}>
        {contenu}
      </a>
    ) : (
      <span key={s.n} title={s.adresse} className={classe}>
        {contenu}
      </span>
    );
  };
  return (
    <div className="mt-3 space-y-1.5">
      {enAvant.length > 0 && (
        <>
          <p className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
            <Globe size={13} strokeWidth={1.75} />
            {citees.length > 0 ? t("Sources du web") : t("Pages consultées sur le web")}
          </p>
          <div className="flex min-w-0 flex-wrap gap-1.5">{enAvant.map(lien)}</div>
        </>
      )}
      {!message.streaming && reste.length > 0 && (
        <div>
          <button
            type="button"
            aria-expanded={autres}
            onClick={() => setAutres((a) => !a)}
            // À gauche : à 375 px, la phrase passe sur deux lignes, centrées par défaut dans un bouton (28/09/2026).
            className="inline-flex items-center gap-1 text-start text-xs text-muted-foreground hover:text-foreground"
          >
            {enAvant.length > 0
              ? tf("{0} autre(s) résultat(s) de recherche, non cité(s)", reste.length)
              : tf("{0} résultat(s) de recherche consulté(s), aucun cité par la réponse", reste.length)}
            <ChevronDown size={12} strokeWidth={2} className={cn("transition-transform", autres && "rotate-180")} />
          </button>
          {autres && <div className="mt-1.5 flex min-w-0 flex-wrap gap-1.5">{reste.map(lien)}</div>}
        </div>
      )}
    </div>
  );
}

function Bubble({ message, onContinuer }: { message: Message; onContinuer?: () => void }) {
  const isUser = message.role === "user";

  if (isUser) {
    // Les pièces jointes en cartes au-dessus du texte ; sans texte tapé, les cartes seules (27/09/2026).
    const pieces = message.pieces ?? [];
    const texte = pieces.length > 0 && message.content === `(${pieces.map((p) => p.nom).join(", ")})` ? "" : message.content;
    return (
      <div className="flex justify-end gap-3">
        <div className="flex max-w-[80%] flex-col items-end gap-2">
          <PiecesJointesMessage pieces={pieces} />
          {texte && (
            <div className="max-w-full rounded-2xl rounded-ee-md bg-muted px-4 py-2.5 text-[15px] leading-relaxed text-foreground">
              {/*
                Une adresse ou un chemin long, sans espace, passe à la ligne
                n'importe où (tournée à l'écran du 28/09/2026) : à 375 px, il
                élargissait la bulle et tout le Chat défilait de côté.
              */}
              {/* `dir="auto"` : le message s'aligne selon sa propre langue, pas celle de l'interface (30/09/2026). */}
              <p dir="auto" className="whitespace-pre-wrap [overflow-wrap:anywhere]">{texte}</p>
            </div>
          )}
        </div>
        <Avatar size={28} className="mt-0.5 shrink-0" />
      </div>
    );
  }

  return (
    <div className="flex gap-3">
      <LogoMark size={26} className="mt-0.5 shrink-0" />
      <div className="min-w-0 flex-1">
        {/* Ce qui se passe avant la réponse, au lieu d'une bulle vide. */}
        {message.streaming && message.statut && (
          <p className="mb-2 flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 size={13} className="shrink-0 animate-spin" />
            {message.statut}
          </p>
        )}
        {message.reasoning && (
          <Reasoning
            text={message.reasoning}
            /*
             * Mesurée (Chat) : en cours tant qu'une phase de réflexion est
             * ouverte. Sans mesure (Code, qui la reçoit d'un bloc), comme
             * avant : tant que rien n'est écrit.
             */
            live={
              message.streaming &&
              (message.durees?.reflexionDepuis !== undefined || (message.durees?.reflexion === undefined && !message.content))
            }
            durees={message.durees}
          />
        )}
        {message.plan && message.plan.length > 0 && <PlanSuivi etapes={message.plan} revue={message.revue} />}
        {message.tools && message.tools.length > 0 && (
          <ToolTraces traces={message.tools} />
        )}
        {/*
          * La réponse, puis l'erreur s'il y en a une. L'erreur remplaçait la
          * réponse : une coupure au milieu d'un plan effaçait de l'écran tout
          * ce qui avait déjà été écrit (et fait), récapitulatif compris.
          */}
        {(!message.error || message.content.trim()) && (
          <div className="text-[15px] leading-relaxed text-foreground">
            {/* Les modèles écrivent en Markdown : mis en forme, sans jamais interpréter de HTML. */}
            <TexteRiche texte={sansMarqueursInternes(message.content)} />
            {message.streaming && (
              <span className="ms-0.5 inline-block h-4 w-[2px] translate-y-0.5 animate-pulse bg-foreground/70" />
            )}
            {message.image && <ImageGeneree image={message.image} />}
          </div>
        )}
        <Sources message={message} />
        <SourcesWeb message={message} />
        <MemoireUtilisee message={message} />
        {message.error && (
          <p
            role="alert"
            className={cn(
              "flex items-start gap-2 rounded-xl border border-destructive/30 bg-destructive/[0.06] px-3 py-2.5 text-sm text-foreground",
              message.content.trim() && "mt-3",
            )}
          >
            <TriangleAlert size={15} strokeWidth={1.75} className="mt-0.5 shrink-0 text-destructive" />
            {/* Coupé n'importe où s'il le faut : une clé masquée (« sk-proj-****… ») sortait de la bulle (29/09/2026). */}
            <span className="min-w-0 [overflow-wrap:anywhere]">{message.error}</span>
          </p>
        )}
        {/*
          * Réponse coupée par sa longueur (16/10/2026) : sans cette note, elle
          * finissait au milieu d'une phrase sans rien qui le dise. « Continuer »
          * demande la suite ; la conversation repart raccourcie si la place
          * manque (gateway/src/historique.ts).
          */}
        {message.coupee && !message.streaming && !message.error && (
          <div className="mt-3 flex flex-wrap items-center gap-2 rounded-xl border border-border bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
            <Scissors size={14} strokeWidth={1.75} className="shrink-0" />
            <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">{message.coupee}</span>
            {onContinuer && (
              <button
                type="button"
                onClick={onContinuer}
                className="rounded-lg border border-border bg-background px-2.5 py-1 text-xs font-medium text-foreground transition-colors hover:bg-muted"
              >
                {t("Continuer")}
              </button>
            )}
          </div>
        )}
        {!message.streaming && <DureeReponse durees={message.durees} />}
      </div>
    </div>
  );
}

/**
 * La durée de la réponse entière, discrète, sous la réponse (27/09/2026).
 * Le délai avant le premier mot s'y ajoute quand il dit autre chose que le
 * total : sur un processeur lent, c'est souvent l'essentiel de l'attente.
 */
function DureeReponse({ durees }: { durees?: DureesReponse }) {
  if (durees?.reponse === undefined) return null;
  const premierMot = durees.premierMot !== undefined && durees.reponse - durees.premierMot >= 1000 ? durees.premierMot : undefined;
  return (
    <p className="mt-2 flex items-center gap-1.5 text-[11px] tabular-nums text-muted-foreground/80">
      <Timer size={11} strokeWidth={1.75} className="shrink-0" />
      <span>
        {tf("Réponse en {0}", dureeMesuree(durees.reponse))}
        {premierMot !== undefined && <> · {tf("premier mot après {0}", dureeMesuree(premierMot))}</>}
      </span>
    </p>
  );
}

/**
 * `onContinuer` : demande la suite d'une réponse coupée par sa longueur ;
 * proposé seulement sous la dernière réponse.
 */
export function MessageList({ messages, onContinuer }: { messages: Message[]; onContinuer?: () => void }) {
  const endRef = useRef<HTMLDivElement>(null);
  /*
   * Suivre le texte qui arrive seulement si la personne est en bas (vu par
   * Medhi le 28/09/2026 : pendant la réflexion, impossible de remonter lire
   * la conversation, chaque mot ramenait tout en bas). Dès qu'elle remonte,
   * on ne bouge plus ; elle redescend, le suivi reprend. Un message qu'elle
   * vient d'envoyer ramène toujours en bas.
   */
  const suivre = useRef(true);
  const nombre = useRef(messages.length);

  useEffect(() => {
    const conteneur = endRef.current?.closest(".overflow-y-auto");
    if (!(conteneur instanceof HTMLElement)) return;
    const surDefilement = () => {
      suivre.current = conteneur.scrollHeight - conteneur.scrollTop - conteneur.clientHeight < 80;
    };
    conteneur.addEventListener("scroll", surDefilement, { passive: true });
    return () => conteneur.removeEventListener("scroll", surDefilement);
  }, []);

  useEffect(() => {
    const nouveau = messages.length !== nombre.current;
    nombre.current = messages.length;
    if (nouveau && messages[messages.length - 1]?.role === "user") suivre.current = true;
    if (!suivre.current) return;
    // Sans animation : un défilement doux, repris à chaque mot, se battait avec la main de la personne.
    endRef.current?.scrollIntoView({ block: "end" });
  }, [messages]);

  return (
    <div className="space-y-6">
      {messages.map((m, i) => (
        <Bubble key={m.id} message={m} onContinuer={i === messages.length - 1 ? onContinuer : undefined} />
      ))}
      <div ref={endRef} />
    </div>
  );
}

export default MessageList;
