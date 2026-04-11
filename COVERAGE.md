# Coverage

## Overview

This MCP server covers regulatory publications issued by **Komisja Nadzoru Finansowego (KNF)** — the Polish Financial Supervision Authority.

| Attribute | Value |
|---|---|
| Coverage type | `regulatory_publications` |
| Jurisdiction | Poland (PL) |
| Authority | Komisja Nadzoru Finansowego (KNF) |
| Authority URL | https://www.knf.gov.pl/ |
| Audit cadence | Monthly |
| Languages | Polish (primary), English (descriptions) |

## Sourcebooks

| ID | Name | Description | Source URL |
|---|---|---|---|
| `KNF_REKOMENDACJE` | KNF Rekomendacje | Recommendations for banks and supervised financial institutions | https://www.knf.gov.pl/regulacje_i_praktyka/regulacje_i_wytyczne/rekomendacje |
| `KNF_WYTYCZNE` | KNF Wytyczne | Guidelines for financial sector participants on operational, IT, and compliance matters | https://www.knf.gov.pl/regulacje_i_praktyka/regulacje_i_wytyczne/wytyczne |
| `KNF_STANOWISKA` | KNF Stanowiska | KNF positions and statements on regulatory interpretation | https://www.knf.gov.pl/regulacje_i_praktyka/regulacje_i_wytyczne/stanowiska |

## In Scope

- KNF recommendations (rekomendacje) for banks, insurance companies, capital market participants
- KNF guidelines (wytyczne) on IT risk, outsourcing, AML, cloud, payment services
- KNF positions (stanowiska) on supervisory expectations
- KNF enforcement actions (decyzje administracyjne): fines, licence withdrawals, bans, warnings

## Out of Scope

- EU-level regulations (MiFID II, CRD, Solvency II) — covered by separate EU Regulations MCP
- Polish statutes (Ustawa o nadzorze nad rynkiem finansowym, etc.) — covered by Polish law MCPs
- KNF press releases and non-regulatory publications

## Data Freshness

Data is ingested from knf.gov.pl by the `scripts/ingest-knf.ts` crawler. The ingest workflow runs on a monthly schedule (see `.github/workflows/ingest.yml`). Use the `pl_fin_check_data_freshness` tool to verify the current data age.

## Known Gaps

- Enforcement actions database may not include all historical decisions prior to 2020
- Some KNF Q&A documents may not be fully indexed depending on HTML structure at time of crawl
