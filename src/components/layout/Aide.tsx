import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ArrowLeft, Bug, ClipboardCheck, Copy, ExternalLink, LifeBuoy, Mail } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { SearchInput } from "@/components/ui/SearchInput";
import { TexteRiche } from "@/components/ui/TexteRiche";
import { Button } from "@/components/ui/Button";
import { branding } from "@/config/branding";
import { instance, isDesktopApp } from "@/lib/instance";
import { chercherArticles, type Article } from "@/lib/aide";
import { t, tf } from "@/lib/i18n";
import { copierTexte } from "@/lib/pressePapiers";

/**
 * Aide et support, dans la fenêtre.
 *
 * Trois choses, et pas une de plus : chercher une réponse, joindre le support
 * de l'agence, et copier les informations qu'on vous demandera de toute façon.
 * Les articles vivent dans `lib/aide.ts` ; aucun ne part chercher quoi que ce
 * soit sur Internet, l'aide d'un logiciel souverain doit marcher hors ligne.
 * Depuis le 27/09/2026, « Besoin d'une personne » mène aussi à l'écran
 * « Signaler un problème » (Paramètres), qui prépare un ticket ou un mail.
 */

/** Ce qu'on demande toujours à quelqu'un qui signale un problème. */
function informationsTechniques(): string {
  const i = instance();
  return [
    `${branding.name} ${branding.version}`,
    tf("Cadre : {0}", isDesktopApp() ? t("application de bureau") : t("navigateur")),
    tf("Instance : {0}", i.remote ? i.url : t("poste seul")),
    tf("Système : {0}", navigator.userAgent),
    tf("Langue : {0}", navigator.language),
    tf("Date : {0}", new Date().toISOString()),
  ].join("\n");
}

/**
 * « Copié » seulement quand c'est vrai. Vu par Medhi le 27/09/2026 sur un PC
 * Windows : le bouton ne faisait rien. La copie était refusée par
 * l'application (permission du presse-papiers), et l'échec avalé sans un mot.
 * Elle passe désormais par `lib/pressePapiers` ; si elle échoue encore, le
 * texte s'affiche sous les boutons, déjà sélectionné, pour le copier au clavier.
 */
function BoutonCopier({ onEchec }: { onEchec: (texte: string | null) => void }) {
  const [copie, setCopie] = useState(false);
  const minuterie = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(minuterie.current), []);
  return (
    <Button
      variant="secondary"
      icon={copie ? ClipboardCheck : Copy}
      onClick={() => {
        const texte = informationsTechniques();
        void copierTexte(texte).then((ok) => {
          window.clearTimeout(minuterie.current);
          setCopie(ok);
          onEchec(ok ? null : texte);
          if (ok) minuterie.current = window.setTimeout(() => setCopie(false), 2500);
        });
      }}
    >
      {copie ? t("Copié") : t("Copier les informations techniques")}
    </Button>
  );
}

/** Le texte que la copie n'a pas pu poser, sélectionné d'office. */
function CopieRefusee({ texte }: { texte: string }) {
  const champ = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    champ.current?.focus();
    champ.current?.select();
  }, [texte]);
  return (
    <div className="space-y-1.5">
      <p className="text-xs font-medium text-foreground" role="status">
        {t("Copie automatique refusée : le texte est sélectionné, copiez-le au clavier.")}
      </p>
      <textarea
        ref={champ}
        readOnly
        value={texte}
        rows={6}
        aria-label={t("Informations techniques")}
        onFocus={(e) => e.currentTarget.select()}
        className="w-full resize-none rounded-xl border border-border bg-muted/40 p-2.5 font-mono text-[12px] leading-relaxed text-foreground"
      />
    </div>
  );
}

/**
 * Mène à l'écran « Signaler un problème » (27/09/2026) : un ticket GitHub ou
 * un mail préremplis, que la personne relit et envoie elle-même. L'aide se
 * referme d'abord, sans quoi elle cacherait l'écran qu'on vient d'ouvrir.
 */
function BoutonSignaler({ onOuvrir }: { onOuvrir: () => void }) {
  const navigate = useNavigate();
  return (
    <Button
      variant="secondary"
      icon={Bug}
      onClick={() => {
        onOuvrir();
        navigate("/parametres/signaler");
      }}
    >
      {t("Signaler un problème")}
    </Button>
  );
}

function Lecture({ article, onRetour, onOuvrir }: { article: Article; onRetour: () => void; onOuvrir: () => void }) {
  const navigate = useNavigate();
  return (
    <div>
      <button
        type="button"
        onClick={onRetour}
        className="mb-3 inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
      >
        <ArrowLeft size={14} strokeWidth={1.75} />
        {t("Tous les sujets")}
      </button>
      <h3 className="text-lg font-semibold text-foreground">{article.titre}</h3>
      <TexteRiche texte={article.corps} className="mt-3 text-sm leading-relaxed text-muted-foreground" />
      {article.lien && (
        <div className="mt-4">
          <Button
            variant="secondary"
            onClick={() => {
              // L'aide se referme : ouverte par-dessus, elle cachait l'écran qu'on venait d'ouvrir, et le bouton semblait sans effet.
              onOuvrir();
              navigate(article.lien!);
            }}
          >
            {t("Ouvrir l'écran concerné")}
          </Button>
        </div>
      )}
    </div>
  );
}

export function Aide({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [terme, setTerme] = useState("");
  const [ouvert, setOuvert] = useState<string | null>(null);
  const [copieRefusee, setCopieRefusee] = useState<string | null>(null);
  const trouves = useMemo(() => chercherArticles(terme), [terme]);
  const article = ouvert ? trouves.find((a) => a.id === ouvert) ?? null : null;

  const fermer = () => {
    onClose();
    // L'état se remet à zéro une fois la fenêtre refermée, pas pendant :
    // rouvrir l'aide doit repartir de la liste, sans clignotement.
    setTimeout(() => {
      setTerme("");
      setOuvert(null);
      setCopieRefusee(null);
    }, 200);
  };

  return (
    <Modal open={open} onClose={fermer} size="lg">
      <div className="mb-4 flex items-center gap-2.5">
        <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-muted">
          <LifeBuoy size={18} strokeWidth={1.75} className="text-foreground" />
        </span>
        <div>
          <h2 className="text-lg font-semibold text-foreground">{t("Aide et support")}</h2>
          <p className="text-xs text-muted-foreground">
            {branding.name} {branding.version}
          </p>
        </div>
      </div>

      {article ? (
        <Lecture article={article} onRetour={() => setOuvert(null)} onOuvrir={fermer} />
      ) : (
        <>
          <SearchInput
            placeholder={t("Chercher dans l'aide...")}
            aria-label={t("Chercher dans l'aide")}
            value={terme}
            onChange={(e) => setTerme(e.target.value)}
          />
          <ul className="mt-3 max-h-[46vh] space-y-1 overflow-y-auto">
            {trouves.length === 0 && (
              <li className="px-1 py-3 text-sm text-muted-foreground">
                {t("Aucun sujet ne correspond. Écrivez au support, plus bas : une question sans réponse ici est un manque de notre côté.")}
              </li>
            )}
            {trouves.map((a) => (
              <li key={a.id}>
                <button
                  type="button"
                  onClick={() => setOuvert(a.id)}
                  className="w-full rounded-xl px-3 py-2.5 text-start transition-colors hover:bg-muted"
                >
                  <span className="block text-sm font-medium text-foreground">{a.titre}</span>
                  <span className="mt-0.5 block text-xs text-muted-foreground">{a.resume}</span>
                </button>
              </li>
            ))}
          </ul>
        </>
      )}

      <div className="mt-5 space-y-3 border-t border-border pt-4">
        <p className="text-sm font-medium text-foreground">{t("Besoin d'une personne")}</p>
        <div className="flex flex-wrap items-center gap-2">
          {branding.urls.supportEmail && (
          <a
            href={`mailto:${branding.urls.supportEmail}?subject=${encodeURIComponent(
              tf("{0} {1} : demande d'aide", branding.name, branding.version),
            )}`}
            className="inline-flex items-center gap-2 rounded-xl border border-border px-3 py-2 text-sm text-foreground transition-colors hover:bg-muted"
          >
            <Mail size={15} strokeWidth={1.75} />
            {branding.urls.supportEmail}
          </a>
          )}
          {branding.urls.marketing && (
          <a
            href={branding.urls.marketing}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-2 rounded-xl border border-border px-3 py-2 text-sm text-foreground transition-colors hover:bg-muted"
          >
            <ExternalLink size={15} strokeWidth={1.75} />
            {t("Site du prestataire")}
          </a>
          )}
          <BoutonCopier onEchec={setCopieRefusee} />
          <BoutonSignaler onOuvrir={fermer} />
        </div>
        {copieRefusee && <CopieRefusee texte={copieRefusee} />}
        <p className="text-xs leading-relaxed text-muted-foreground">
          {t("Les informations techniques ne contiennent ni vos messages, ni vos documents, ni aucune clé : seulement la version, le cadre d'exécution, l'adresse de l'instance et votre système.")}
        </p>
      </div>
    </Modal>
  );
}

export default Aide;
