# frida-bot

Bot WhatsApp qui surveille la billetterie de la **Casa Azul** (Museo Frida Kahlo) et te propose les créneaux dispo dès qu'ils s'ouvrent. Sur ta validation, il pré-remplit le panier jusqu'à la page de paiement — toi tu cliques "payer" et tu valides le 3DS.

> ⚠️ **Pas un bot d'achat 100% auto.** Pas de bypass de captcha, pas de stockage CB. Le compromis : tu fais 1 clic + 3DS, le bot fait les 99% restants.

## Installation

Prérequis : Node.js 20+ (tu as déjà 24 ✅).

```bash
cd "D:/nicoh/Documents/Frida Khalo/frida-bot"
npm install
# le postinstall télécharge Chromium pour Playwright (~150 Mo)
```

## Configuration

```bash
cp .env.example .env
# édite .env :
#   TARGET_DATE=2026-05-04
#   TICKETS=4
#   WHATSAPP_OWNER=33XXXXXXXXX     # ton numéro WhatsApp, format international, sans + ni espaces
#   BUYER_NAME=Hadrien
#   BUYER_EMAIL=...
```

## Lancement

```bash
npm start
```

Au premier démarrage, **un QR code apparaît dans le terminal**.
Sur ton téléphone : WhatsApp → ⋮ → **Appareils connectés** → **Connecter un appareil** → scanne le QR.

La session est sauvegardée dans `data/wwebjs-auth/` — pas besoin de re-scanner ensuite.

## Utilisation

Une fois connecté, tu reçois sur WhatsApp (de toi-même) :

```
🤖 Frida-bot en ligne.
Cible: 4 places le 2026-05-04.
```

### Commandes

| Commande | Effet |
|---|---|
| `/check` | force un check de dispo immédiat |
| `/status` | état courant de la conversation |
| `/reset` | annule tout, ferme le navigateur |
| `/done` | marque le paiement comme fait |
| `1`, `2`, ... | choisit un créneau parmi ceux proposés |
| `non` | refuse la proposition |

### Flow normal

1. Toutes les 2 min, le bot check `boletos.museofridakahlo.org.mx`.
2. Si des créneaux ouvrent pour ta date avec ≥ N places : notif WhatsApp.
3. Tu réponds `1` (ou `2`...) pour réserver le créneau choisi.
4. Le bot ouvre **une fenêtre Chromium visible sur ton PC**, navigue, sélectionne, pré-remplit, et s'arrête sur la page de paiement.
5. Tu vas sur ton PC, tu vérifies le panier, tu tapes ta CB, tu valides 3DS sur ton tel.
6. Tu tapes `/done` sur WhatsApp pour fermer.

## Test (sans payer)

Pour tester le 4 mai sans transaction :

1. `npm start`, scanne le QR.
2. Tape `/check` sur WhatsApp.
3. Si créneaux dispo → réponds avec un numéro.
4. La fenêtre Chromium s'ouvre, le panier se remplit.
5. **Ne paye pas.** Tape `/cancel` ou ferme la fenêtre.

## Debug

- `HEADED=true npm start` → toutes les sessions Playwright sont visibles (utile si le scraping foire).
- Screenshots d'erreur dans `screenshots/`.
- Logs : `pino-pretty` dans la console, niveau via `LOG_LEVEL` (`debug` pour tout voir).

## Limites connues

- **PC éteint = monitoring off.** Pour du 24/7, déployer sur un petit serveur (Railway, Fly.io).
- **Sélecteurs Fever peuvent changer.** Si tu vois "date_not_found" dans les logs, ouvre `screenshots/pickdate-failed-*.png` et adapte les sélecteurs dans `src/_pickDate.js` et `src/booking.js`.
- **whatsapp-web.js** est non-officiel. Risque de ban faible mais non nul. Si ton compte se fait kicker, on bascule sur Twilio.

## Structure

```
src/
├── index.js          # entrypoint, scheduler
├── config.js         # .env loader
├── logger.js         # pino
├── state.js          # state.json
├── whatsapp.js       # client whatsapp-web.js
├── browser.js        # helper Playwright
├── _pickDate.js      # helper calendrier
├── monitor.js        # check dispo (headless)
└── booking.js        # remplissage panier (headed)
```
