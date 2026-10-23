import { useEffect, useRef, useState } from "react";
import { Outlet, useLocation } from "react-router-dom";
import { WindowChrome } from "./WindowChrome";
import { Sidebar } from "./Sidebar";
import { MainArea } from "./MainArea";
import { AvisChatsIllisibles } from "./AvisChatsIllisibles";
import { FenetreMiseAJour } from "./FenetreMiseAJour";
import { FenetreNouveautes } from "./FenetreNouveautes";
import { ScreenApproval } from "@/components/cowork/ScreenApproval";
import { useBotAutomatique } from "@/hooks/useBotAutomatique";
import { demarrerNotifications } from "@/lib/notifications";

/**
 * En dessous de cette largeur, la barre latérale dépliée (248 px) laisse moins
 * de la moitié de la fenêtre à l'écran : relevé le 27/09/2026 à 375 px, il
 * restait 127 px au Chat et à Code, illisibles. Elle part donc en rail, et s'y
 * range quand la fenêtre rétrécit ; elle ne se redéplie pas seule quand la
 * fenêtre s'élargit (c'est à la personne de le vouloir).
 */
const LARGEUR_ETROITE = 768;
const etroite = () => typeof window !== "undefined" && window.innerWidth < LARGEUR_ETROITE;

/** Coquille applicative : fenetre + barre laterale (repliable) + zone principale. */
export function AppLayout() {
  const [collapsed, setCollapsed] = useState(etroite);
  const location = useLocation();
  const dansParametres = location.pathname.startsWith("/parametres");
  useBotAutomatique();

  useEffect(() => {
    let avant = etroite();
    const surTaille = () => {
      const maintenant = etroite();
      if (maintenant && !avant) setCollapsed(true);
      avant = maintenant;
    };
    window.addEventListener("resize", surTaille);
    return () => window.removeEventListener("resize", surTaille);
  }, []);

  /*
   * Les sources de notifications sont branchées ici, au-dessus des écrans :
   * une mise à jour publiée ou un accord attendu doivent apparaître où que
   * l'on soit, pas seulement sur l'écran qui les concerne.
   */
  useEffect(() => {
    demarrerNotifications();
  }, []);

  /*
   * Les Paramètres s'ouvrent avec la barre latérale en rail (captures 30 et
   * suivantes), mais ce n'est qu'un état de départ : le bouton de repli doit
   * continuer à répondre, sinon on se retrouve coincé en rail tant qu'on est
   * dans les réglages. L'état d'avant est rendu à la sortie.
   */
  const avantParametres = useRef<boolean | null>(null);

  useEffect(() => {
    if (dansParametres) {
      if (avantParametres.current === null) {
        avantParametres.current = collapsed;
        setCollapsed(true);
      }
    } else if (avantParametres.current !== null) {
      setCollapsed(avantParametres.current);
      avantParametres.current = null;
    }
    // `collapsed` est volontairement absent : seul le passage dans les
    // Paramètres, ou la sortie, doit déclencher ce réglage.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dansParametres]);

  return (
    <WindowChrome>
      <Sidebar collapsed={collapsed} onToggle={() => setCollapsed((c) => !c)} />
      <MainArea>
        <Outlet />
        {/* Par-dessus l'écran, où que l'on soit : la liste des Chats vide ou incomplète doit s'expliquer partout. */}
        <AvisChatsIllisibles />
        <FenetreMiseAJour />
        <FenetreNouveautes />
      </MainArea>
      {/*
        Hors de la zone principale : l'agent peut demander un accord pendant que
        l'utilisateur consulte un autre écran, la demande doit le suivre.
      */}
      <ScreenApproval />
    </WindowChrome>
  );
}

export default AppLayout;
