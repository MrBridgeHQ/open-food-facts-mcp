# Open Food Facts MCP sur Apify

Cet Actor propose cinq outils MCP en lecture seule pour consulter les produits Open Food Facts, rechercher des aliments et comparer leurs données nutritionnelles. Il adapte le [serveur open source](https://github.com/MrBridgeHQ/open-food-facts-mcp) au mode Standby d'Apify, avec un endpoint Streamable HTTP `/mcp`.

Projet indépendant, sans affiliation officielle à Open Food Facts. [English documentation](README.md).

## Connexion

Chaque utilisateur doit fournir **sa propre adresse email de contact**, suivie et valide.

1. Créez une **tâche privée** à partir de cet Actor dans votre compte Apify.
2. Renseignez le champ obligatoire **Your contact email** (`contactEmail`) et enregistrez la tâche. Aucune adresse n'est préremplie.
3. Activez Standby pour cette tâche et la transmission de son input (`actorStandby.shouldPassActorInput: true`). Le propriétaire de l'Actor doit autoriser la configuration au niveau des tâches.
4. Copiez l'URL Standby réelle de la tâche dans son onglet Endpoints.
5. Dans votre client MCP, choisissez **Streamable HTTP**, cette URL suivie de `/mcp`, et `Authorization: Bearer <votre token API Apify>`.

Conservez le token dans la configuration secrète du client. L'URL de votre tâche permet de transmettre votre configuration au run.

La passerelle Apify authentifie les appels. Les en-têtes d'autorisation et les cookies entrants ne sont pas transmis à Open Food Facts. Les clients MCP de la génération 2025 peuvent recevoir des réponses SSE finies. Les abonnements persistants et l'ancien transport séparé `/sse` ne sont pas exposés.

Le bouton **Start** lit et valide votre input, contrôle le démarrage et la liste des outils, puis termine le run sans appel Open Food Facts. Pour utiliser le MCP, connectez-vous à l'URL **Standby**. Un run classique ne produit ni dataset ni URL MCP permanente. La plateforme démarre les conteneurs à la demande ; le délai dépend de son état.

## Outils

| Outil | Usage | Exemple d'arguments |
| --- | --- | --- |
| `get_product` | Produit par code-barres | `{"barcode":"3017620422003","language":"fr"}` |
| `search_products` | Recherche par filtres de taxonomie | `{"country":"en:france","category":"en:chocolates","page_size":5}` |
| `search_text` | Recherche textuelle | `{"query":"chocolat noir","page_size":5}` |
| `get_taxonomy` | Suggestions de catégories, marques, pays, ingrédients, additifs, allergènes ou labels | `{"query":"chocolat","taxonomy":"categories","language":"fr","limit":5}` |
| `compare_products` | Comparaison de 2 à 5 codes distincts | `{"barcodes":["3017620422003","3017620425035"]}` |

Ces arguments appartiennent aux appels MCP ; ce ne sont pas des champs du formulaire d'entrée de l'Actor. Les produits cités peuvent changer ou être indisponibles. Chaque succès contient la source, la date de consultation, l'état du cache, les données, les champs manquants et les avertissements. Les erreurs d'outil portent `isError: true`, même si le statut HTTP vaut 200. Le [contrat complet](https://github.com/MrBridgeHQ/open-food-facts-mcp/blob/main/docs/architecture.md) décrit les sorties.

## Configuration et déploiement

Utilisez le dépôt GitHub comme source Git de l'Actor. `.actor/actor.json` désigne le Dockerfile et les schémas. Ne préremplissez aucun email dans la configuration commune : chaque utilisateur renseigne `contactEmail` dans sa tâche privée. Ce champ est obligatoire dans le formulaire et contrôlé au démarrage.

Pour chaque tâche, activez la transmission de l'input :

```json
{
  "actorStandby": {
    "isEnabled": true,
    "shouldPassActorInput": true
  }
}
```

Ce fragment configure la tâche sur Apify ; ce n'est ni un argument MCP ni une propriété supplémentaire d'`actor.json`. Le propriétaire doit laisser les surcharges de configuration des tâches autorisées. Références : [création de tâche](https://docs.apify.com/api/v2/actor-tasks-post), [configuration Standby](https://docs.apify.com/actors/running/standby).

Sur Apify, le serveur lit l'input du run dans son stockage clé-valeur par défaut avec le token fourni par la plateforme, puis construit `open-food-facts-mcp/0.1.0 (<contactEmail>)`. Un email manquant ou invalide bloque le démarrage. Aucune adresse développeur ni variable partagée `OFF_USER_AGENT` ne sert de remplacement.

Les lectures publiques ne nécessitent pas de clé Open Food Facts. Apify fournit le port et les URL via `ACTOR_WEB_SERVER_PORT`, `ACTOR_STANDBY_URL` et `ACTOR_WEB_SERVER_URL`. Le serveur écoute sur `0.0.0.0` sur Apify et contrôle les en-têtes Host et Origin d'après ces URL.

Activez Standby sur un build réussi. Les 256 Mo de mémoire proposés constituent une allocation de départ à vérifier pendant la validation sur la plateforme. Aucun tarif par événement n'est implémenté ; les frais d'infrastructure de votre compte Apify restent applicables. Créer un Actor ne le publie pas automatiquement dans le Store.

## Développement local

Prérequis : Node.js 22.23 ou plus récent et Python 3. Dans un clone neuf, sans dossier `node_modules` :

```sh
python3 -B scripts/bootstrap-locked.py
node node_modules/typescript/bin/tsc --project apify/tsconfig.json --noEmit
node --experimental-strip-types --test tests/*.test.ts
```

Si les dépendances sont déjà installées, omettez le bootstrap. Pour démarrer :

```sh
export OFF_CONTACT_EMAIL='votre-contact@example.org'
node --experimental-strip-types apify/main.ts
```

Remplacez l'exemple par votre propre adresse. Cette entrée HTTP exige `OFF_CONTACT_EMAIL` ; l'entrée STDIO conserve sa configuration existante `OFF_USER_AGENT`.

Le MCP local est accessible sur `http://127.0.0.1:4321/mcp`. `GET /` vérifie la disponibilité sans appel Open Food Facts. La variable facultative `OFF_LOCAL_BEARER_TOKEN` permet de protéger les appels locaux. Elle est distincte de l'authentification Apify et reste normalement absente sur la plateforme.

Le Dockerfile épingle les images de base par empreinte, vérifie l'intégrité des dépendances, exécute les tests hors ligne et utilise un utilisateur sans privilèges.

## Limites et qualité des données

Dans un même conteneur, les clients partagent le cache, les appels identiques en cours et les quotas par minute glissante : 15 requêtes produit, 10 recherches et 10 requêtes de taxonomie. Le cache dure respectivement 5 minutes, 1 minute et 10 minutes. Ces compteurs ne sont pas partagés entre conteneurs ni entre utilisateurs d'une même IP sortante. Des limites amont peuvent donc s'appliquer. Pour les volumes importants, utilisez les exports Open Food Facts.

Le serveur limite les corps de requête à 64 Kio et les appels MCP simultanés à 16, avec un délai de 30 secondes par requête. L'arrêt laisse jusqu'à 10 secondes aux requêtes actives avant fermeture des connexions.

Les données communautaires peuvent être incomplètes. Une valeur manquante n'est pas zéro ; l'absence d'allergène renseigné ne garantit pas son absence. La comparaison exige des bases nutritionnelles et des préparations compatibles. Les résultats ne constituent pas un avis médical ou une garantie alimentaire.

## Licence et assistance

Le code est sous [licence MIT](https://github.com/MrBridgeHQ/open-food-facts-mcp/blob/main/LICENSE). Les données ont des conditions séparées : ODbL pour la base, DbCL pour les contenus individuels, CC BY-SA pour les images. Consultez les [conditions de réutilisation](https://world.openfoodfacts.org/terms-of-use).

Signalez les problèmes dans les [issues GitHub](https://github.com/MrBridgeHQ/open-food-facts-mcp/issues). Références : [Standby](https://docs.apify.com/actors/development/programming-interface/standby), [authentification](https://docs.apify.com/actors/running/standby), [définition d'Actor](https://docs.apify.com/actors/development/actor-definition/actor-json).

### Compatibilité des clients et Origin

Les clients natifs ou serveur omettent généralement `Origin`. S'il est envoyé, il doit correspondre exactement à une origine des URL configurées du serveur. Ce wrapper n'active pas les clients navigateur entre origines différentes et n'envoie pas de CORS générique. Le routage réel de la passerelle reste à valider lors du déploiement.

## Utilisation de l'email

L'adresse est enregistrée dans l'input de votre tâche/run Apify et transmise à Open Food Facts dans les en-têtes des requêtes comme contact pour votre usage. L'application ne l'écrit pas dans ses logs ni dans les résultats MCP. Elle vérifie la syntaxe, pas la possession ni la délivrabilité de la boîte. Conservez la tâche et le token privés ; en cas de changement d'adresse, enregistrez la nouvelle valeur avant un nouveau run.

Apify documente une isolation des runs Standby par compte utilisateur. Le serveur utilise un contact par run ; il ne distingue pas plusieurs personnes partageant le même compte, la même tâche ou le même token. Chaque utilisateur indépendant doit disposer de sa propre configuration.
