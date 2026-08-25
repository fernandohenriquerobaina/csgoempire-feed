# CSGOEmpire Collector v1.5.1

Correção sobre a V1.5 para os `HTTP 503` encontrados nos endpoints individuais de Baseball.

## O que mudou

A coleta de `/event/en/{event_id}` agora faz:

1. GET pelo `BrowserContext.request`
2. retry automático para 408/425/429/500/502/503/504
3. envio de `Origin` e `Referer`
4. se ainda falhar, GET via `fetch()` **dentro da única página Chromium já aberta**
5. retries também no fallback

O fallback NÃO abre uma página por evento e NÃO cria abas novas.

Isso é importante porque o feed geral estava encontrando os eventos normalmente,
mas o endpoint individual estava devolvendo 503 para a chamada HTTP separada.

## Teste recomendado

```bash
node index.js --only=baseball --hours=2 --include-raw --concurrency=1
```

Se funcionar, você poderá ver mensagens como:

```text
Detalhe 2703355547620614145: fallback pelo browser OK
```

e no final:

```text
Baseball: 6
```

Depois teste com concorrência normal:

```bash
node index.js --only=baseball --hours=2 --include-raw
```

E, por fim, os cinco esportes:

```bash
node index.js --hours=24
```