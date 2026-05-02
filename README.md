# Polish Financial Regulation MCP

MCP server for KNF (Polish Financial Supervision Authority) financial regulations

[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)
[![MCP](https://img.shields.io/badge/MCP-spec--compliant-green.svg)](https://modelcontextprotocol.io)

## What this is

MCP server for KNF (Polish Financial Supervision Authority) financial regulations

Part of the Ansvar MCP fleet — source-available servers published for self-hosting.

## Two ways to use it

**Self-host (free, Apache 2.0)** — clone this repo, run the ingestion script to build your local database from the listed upstream sources, point your MCP client at the local server. Instructions below.

**Trial the hosted gateway (paid pilot, B2B)** — for production use against
the curated, kept-fresh corpus across the full Ansvar MCP fleet at once, with
citation enrichment, multi-jurisdiction fan-out, and audit-ledgered query
logs, see [ansvar.eu](https://ansvar.eu).

## Self-hosting

### Install

```bash
git clone https://github.com/Ansvar-Systems/polish-financial-regulation-mcp.git
cd polish-financial-regulation-mcp
npm install
```

### Build

```bash
npm run build
```

### Build the database

```bash
npm run ingest
```

Ingestion fetches from the upstream source(s) listed under **Sources** below and builds a local SQLite database. Re-run periodically to refresh. Review the source's published terms before running ingestion in a commercial deployment, and inspect the ingestion script in this repo for the actual access method (open API, bulk download, HTML scrape, or feed).

### Configure your MCP client

```json
{
  "mcpServers": {
    "polish-financial-regulation-mcp": {
      "command": "node",
      "args": ["dist/src/index.js"]
    }
  }
}
```

## Sources

| Source | Source URL | Terms / license URL | License basis | Attribution required | Commercial use | Redistribution / caching | Notes |
|---|---|---|---|---|---|---|---|
| [KNF (Komisja Nadzoru Finansowego)](https://www.knf.gov.pl/) | https://www.knf.gov.pl/ | [Terms](https://www.knf.gov.pl/) | Public domain (statutes) — Polish Copyright Act (Ustawa o prawie autorskim) Art. 4 excludes legal acts (akty normatywne), official documents, and material published by state authorities from copyright; KNF does not publish a separate Creative Commons site licence | Yes | Conditional | Conditional | Scrapes k |

## What this repository does not provide

This repository's source — the MCP server code, schema, and ingestion script — is licensed under Apache
2.0. The license below covers the code in this repository only; it does not
extend to upstream materials. Pre-built database snapshots under `data/` (e.g. `knf.db`) are shipped as a transitional convenience while the build pipeline is migrated to mount the corpus from a separate volume; they are scheduled for removal in a Phase 2 release. Their presence does not change the legal positioning above — running ingestion is still the canonical way to build a fresh corpus from upstream sources.

Running ingestion may download, cache, transform, and index materials from the listed upstream sources. You are responsible for confirming that your use of those materials complies with the source terms, attribution requirements, robots/rate limits, database rights, copyright rules, and any commercial-use or redistribution limits that apply in your jurisdiction.

## License

Apache 2.0 — see [LICENSE](LICENSE). Commercial use, modification, and
redistribution of **the source code in this repository** are permitted under
that license. The license does not extend to upstream materials downloaded by the ingestion script; those remain governed by their respective source terms listed above.

## The Ansvar gateway

If you'd rather not self-host, [ansvar.eu](https://ansvar.eu) provides this
MCP plus the full Ansvar fleet through a single OAuth-authenticated endpoint,
with the curated production corpus, multi-MCP query orchestration, citation
enrichment, and (on the company tier) a per-tenant cryptographic audit
ledger. Pilot mode, B2B only.
