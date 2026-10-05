# Open Food Facts MCP

Un serveur [Model Context Protocol](https://modelcontextprotocol.io/) en lecture seule pour consulter Open Food Facts depuis un client MCP. Il s'agit d'un projet communautaire indépendant, sans affiliation ni soutien déclaré d'Open Food Facts.

Le serveur requiert Node.js 22.23 ou ultérieur. Il utilise TypeScript, `@modelcontextprotocol/server` 2.0.0 et Zod 4, avec le transport MCP STDIO. Il consulte les données publiques de produits, de recherche et de taxonomie. Il ne modifie pas les fiches, n'envoie pas de photos et ne formule pas d'allégations de santé.

## Outils

| Outil | Arguments |
| --- | --- |
| `get_product` | `barcode` (4 à 32 chiffres), `language` facultatif |
| `search_products` | `country`, `category`, `brand` (étiquettes de taxonomie), `nutriscore` (`a` à `e`), `page` (1 à 1000), `page_size` (1 à 20) et `language`, tous facultatifs |
| `search_text` | `query` (1 à 120 caractères), `page` (1 à 1000), `page_size` (1 à 20) et `language`, ces trois derniers facultatifs |
| `get_taxonomy` | `query` (1 à 100 caractères), `taxonomy` (`categories`, `brands`, `countries`, `ingredients`, `additives`, `allergens` ou `labels`), puis `language` facultatif et `limit` facultatif (1 à 20) |
| `compare_products` | `barcodes` (2 à 5 codes distincts de 4 à 32 chiffres chacun), `language` facultatif |

Les arguments sont illustrés dans [examples/tool-calls.json](examples/tool-calls.json). [docs/architecture.md](docs/architecture.md) décrit le format des réponses, les endpoints, le traitement nutritionnel et les limites de requêtes.

## Lancer en local

Ce dépôt n'est pas publié comme paquet npm. Clonez-le, installez ses dépendances et lancez ces vérifications depuis le dépôt :

```sh
npm install
npm run typecheck
npm test
```

Avant de démarrer le serveur, définissez `OFF_USER_AGENT` avec le nom et la version de l'application, suivis d'une adresse de contact suivie :

```sh
export OFF_USER_AGENT='open-food-facts-mcp/0.1.0 (vous@example.org)'
npm start
```

Remplacez l'adresse d'exemple par votre contact. Open Food Facts demande un `User-Agent` descriptif qui identifie l'application et fournit un moyen de la contacter. Ces opérations de lecture n'utilisent pas de clé d'API.

### Configuration d'un client MCP

Le serveur utilise STDIO. Ajoutez une entrée de ce type à la configuration de votre client MCP, puis remplacez le chemin du dépôt et l'adresse de contact :

```json
{
  "mcpServers": {
    "open-food-facts": {
      "command": "node",
      "args": [
        "--experimental-strip-types",
        "/chemin/absolu/vers/open-food-facts-mcp/src/index.ts"
      ],
      "env": {
        "OFF_USER_AGENT": "open-food-facts-mcp/0.1.0 (vous@example.org)"
      }
    }
  }
}
```

N'écrivez pas de journaux sur stdout dans un processus MCP STDIO : ce flux transporte les messages du protocole.

## Données et précautions d'usage

Open Food Facts est une base alimentée par la communauté. Sa documentation API précise que les données des produits peuvent être incomplètes ou inexactes. Un champ manquant ne vaut pas zéro. L'absence d'une mention d'allergène ne prouve pas qu'un produit en est exempt. Les valeurs nutritionnelles peuvent concerner 100 g, 100 ml, une portion ou un état de préparation ; ne les comparez que si la base et la préparation concordent.

Chaque réponse réussie comprend les URL des sources, l'heure de récupération, l'état du cache, les champs manquants et les avertissements. La sortie nutritionnelle conserve le jeu agrégé v3 et sa base avec les jeux de saisie disponibles et leur provenance ; les valeurs historiques de `nutriments` restent séparées. Les notes d'architecture détaillent les comparaisons et les limites.

Open Food Facts documente actuellement des limites de 15 lectures de produit et de 10 recherches par minute et par adresse IP. Le serveur applique aussi ses propres limites et caches en mémoire. Plusieurs processus partageant une adresse IP ne coordonnent ni leurs compteurs ni leurs caches. Évitez les recherches répétées à cadence élevée. Pour les usages hors ligne, analytiques ou en masse, suivez les recommandations d'Open Food Facts sur les exports ou la mise en cache locale plutôt que d'interroger l'API en boucle.

Ce logiciel est distribué sous licence MIT ; voir [LICENSE](LICENSE). Les données Open Food Facts relèvent de conditions distinctes : la base est sous ODbL, ses contenus individuels sous DbCL et les images de produits sous CC BY-SA. Ces licences des données sont indépendantes de la licence du logiciel. Lisez les [conditions de réutilisation](https://world.openfoodfacts.org/terms-of-use) avant de redistribuer des données ou des images.

## Projets apparentés

Parmi les projets communautaires du domaine figurent [domdomegg/openfoodfacts-mcp](https://github.com/domdomegg/openfoodfacts-mcp), [cyanheads/openfoodfacts-mcp-server](https://github.com/cyanheads/openfoodfacts-mcp-server) et [noot-app/openfoodfacts-mcp-server](https://github.com/noot-app/openfoodfacts-mcp-server). Ce projet se concentre sur une sélection compacte d'outils en lecture seule, avec des bases nutritionnelles v3.6 et une provenance explicites.

## Références

- [Documentation de l'API Open Food Facts](https://openfoodfacts.github.io/openfoodfacts-server/api/)
- [Historique des versions de l'API et du schéma produit](https://openfoodfacts.github.io/openfoodfacts-server/api/ref-api-and-product-schema-change-log/)
- [Données et conditions de réutilisation Open Food Facts](https://world.openfoodfacts.org/data)

## Actor Apify

Une entrée Streamable HTTP est disponible pour Apify Standby. La [documentation française de l’Actor](apify/README.fr.md) décrit `/mcp`, l’authentification, le déploiement, le lancement HTTP local et les limites. L’entrée STDIO reste disponible.
