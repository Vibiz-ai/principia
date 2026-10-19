---
name: firecrawl
description: Scrape, crawl or search the web with the Firecrawl API using the FIRECRAWL_API_KEY environment variable. Use when you need the content of a web page as Markdown or need to crawl a site.
---

# Firecrawl

The key is in `$FIRECRAWL_API_KEY` (Hive injects it from Keys). Never print it or write it to a file.

Scrape one page:

```sh
curl -s https://api.firecrawl.dev/v1/scrape \
  -H "Authorization: Bearer $FIRECRAWL_API_KEY" -H 'Content-Type: application/json' \
  -d '{"url":"https://example.com","formats":["markdown"]}' | jq -r .data.markdown
```

Crawl a site (async): POST `/v1/crawl` with `{"url": ..., "limit": 20}`, then GET `/v1/crawl/<id>` until `status` is `completed`.

Search: POST `/v1/search` with `{"query": ..., "limit": 5}`.

Save outputs under `$ARTIFACTS_DIR` when it is set. If the key is missing, tell the user to add FIRECRAWL_API_KEY in Hive › Keys.
