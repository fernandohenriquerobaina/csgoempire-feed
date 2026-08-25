# CSGOEmpire Feed — GitHub Actions + GitHub Pages

Este pacote usa o collector **v1.5.1** e publica automaticamente os JSONs sem precisar deixar seu PC ligado.

## O que ele faz

- `latest-6h.json`: atualizado a cada **30 minutos**.
- `latest-24h.json`: atualizado a cada **3 horas**.
- Roda Chromium/Playwright em uma VM Ubuntu do GitHub Actions.
- Primeiro tenta Chromium `headless`.
- Se o collector não capturar o feed em headless, tenta novamente em modo headed dentro de `Xvfb`.
- Publica os arquivos na branch `gh-pages`.
- O mesmo endereço continua valendo a cada atualização.

## 1. Crie o repositório

No GitHub, crie um repositório **público**, por exemplo:

`csgoempire-feed`

O repositório público é o caminho mais simples para usar Actions/Pages sem consumir a franquia de minutos de repositórios privados.

## 2. Suba os arquivos

Extraia este ZIP e envie **o conteúdo da pasta** para a raiz do repositório.

Na raiz do GitHub devem aparecer, entre outros:

```text
.github/workflows/collect-and-publish.yml
collector/index.js
collector/package.json
site/index.html
README-GITHUB.md
```

Não envie `node_modules`.

## 3. Rode pela primeira vez manualmente

Abra no repositório:

**Actions > Collect and publish betting feed > Run workflow**

Escolha:

`both`

A primeira execução demora mais porque instala o Chromium.

Se terminar verde, a branch `gh-pages` será criada e deverá conter:

```text
index.html
latest-6h.json
latest-24h.json
```

## 4. Ative o GitHub Pages

Depois da primeira execução:

**Settings > Pages**

Em **Build and deployment** escolha:

- Source: `Deploy from a branch`
- Branch: `gh-pages`
- Folder: `/ (root)`

Salve.

A URL normalmente será:

```text
https://SEU_USUARIO.github.io/NOME_DO_REPOSITORIO/
```

Feeds:

```text
https://SEU_USUARIO.github.io/NOME_DO_REPOSITORIO/latest-6h.json
https://SEU_USUARIO.github.io/NOME_DO_REPOSITORIO/latest-24h.json
```

## 5. Alternativa sem ativar Pages

Como o repositório é público, depois que a branch `gh-pages` existir você também pode usar o RAW do GitHub:

```text
https://raw.githubusercontent.com/SEU_USUARIO/NOME_DO_REPOSITORIO/gh-pages/latest-6h.json
```

Para o ChatGPT, prefira a URL do GitHub Pages quando ela estiver funcionando.

## Horários automáticos

O GitHub usa cron em UTC. Os horários escolhidos são relativos; não importa o fuso porque o objetivo é apenas repetir periodicamente.

### 6 horas

```cron
17,47 * * * *
```

Executa aproximadamente a cada 30 minutos.

### 24 horas

```cron
7 */3 * * *
```

Executa aproximadamente a cada 3 horas.

O GitHub pode atrasar alguns minutos em períodos de fila. O JSON contém `generated_at_utc`; o ChatGPT deve conferir esse campo antes de considerar as odds atuais.

## Como saber se está funcionando

Abra:

```text
https://SEU_USUARIO.github.io/NOME_DO_REPOSITORIO/latest-6h.json
```

No começo do JSON deverá existir algo semelhante a:

```json
{
  "version": "1.5.1",
  "generated_at_utc": "...",
  "filters": {
    "hours_ahead": 6
  }
}
```

A cada nova execução o valor `generated_at_utc` deve mudar.

## Se o workflow falhar

Abra:

**Actions > execução que falhou > Collect feed**

Os cenários mais importantes são:

### `Nenhum endpoint prematch foi capturado`

O pacote já tenta automaticamente uma segunda execução com Chromium headed + Xvfb.

Se as duas falharem, a causa mais provável é comportamento diferente do CSGOEmpire para o IP/datacenter do runner do GitHub. Nesse caso o collector local/ngrok continua sendo o plano de fallback.

### HTTP 503 em detalhes

O collector v1.5.1 já possui:

1. retry via BrowserContext.request;
2. cabeçalhos Origin/Referer;
3. fallback de `fetch()` dentro da página Chromium;
4. retries no fallback.

### Pages retorna 404

Confirme:

- a primeira Action terminou verde;
- a branch `gh-pages` existe;
- Settings > Pages aponta para `gh-pages / (root)`;
- aguarde alguns minutos após a primeira ativação.

## Segurança

Este projeto não precisa e não deve armazenar:

- senha da CSGOEmpire;
- cookies da sua conta;
- Steam Guard;
- sessão Steam;
- credenciais pessoais.

O collector lê apenas o feed público usado pela página de Match Betting.

## Para o ChatGPT

Quando a URL estiver funcionando, use normalmente apenas:

```text
/latest-6h.json
```

O fluxo desejado é:

```text
GitHub Actions
  -> atualiza o JSON
  -> ChatGPT acessa a URL de hora em hora
  -> verifica generated_at_utc
  -> analisa Tennis + CS2 + Football + Basketball + Baseball
  -> pesquisa estatísticas/notícias na web
  -> calcula fair probability / fair odd / EV / confiança / odd mínima
  -> APOSTE / ACOMPANHE / NÃO APOSTE AGORA
```

## Teste local opcional no Windows

Execute:

`test-local-windows.bat`

Ele instala as dependências na primeira vez e gera:

`publish/latest-6h.json`
