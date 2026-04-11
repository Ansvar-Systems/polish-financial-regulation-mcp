# Tools Reference

All tools use the `pl_fin_` prefix. Every response includes `_meta` (disclaimer, data age, copyright, source URL) and relevant tools include `_citation` for entity linking.

## pl_fin_search_regulations

Full-text search across KNF recommendations, guidelines, and positions.

**Input:**
| Parameter | Type | Required | Description |
|---|---|---|---|
| `query` | string | Yes | Search query in Polish or English (e.g. `ryzyko IT`, `outsourcing`) |
| `sourcebook` | string | No | Filter by sourcebook ID (`KNF_REKOMENDACJE`, `KNF_WYTYCZNE`, `KNF_STANOWISKA`) |
| `status` | enum | No | Filter by status: `in_force`, `deleted`, `not_yet_in_force` |
| `limit` | number | No | Max results (default 20, max 100) |

**Returns:** Array of provisions, each with `_citation` metadata.

---

## pl_fin_get_regulation

Fetch a specific KNF provision by sourcebook and reference.

**Input:**
| Parameter | Type | Required | Description |
|---|---|---|---|
| `sourcebook` | string | Yes | Sourcebook ID (e.g. `KNF_REKOMENDACJE`) |
| `reference` | string | Yes | Full reference (e.g. `KNF_REKOMENDACJE D.1.1`) |

**Returns:** Full provision object with `_citation` metadata, or error if not found.

---

## pl_fin_list_sourcebooks

List all KNF sourcebooks with names and descriptions (internal DB view).

**Input:** None

**Returns:** Array of sourcebook records with `id`, `name`, `description`.

---

## pl_fin_list_sources

List all data sources used by this MCP server with URLs and descriptions.

**Input:** None

**Returns:** Array of source objects with `id`, `name`, `description`, `url`, `type`.

---

## pl_fin_search_enforcement

Search KNF enforcement actions — fines, licence withdrawals, bans, warnings.

**Input:**
| Parameter | Type | Required | Description |
|---|---|---|---|
| `query` | string | Yes | Search query (firm name, violation type, etc.) |
| `action_type` | enum | No | Filter: `fine`, `ban`, `restriction`, `warning` |
| `limit` | number | No | Max results (default 20, max 100) |

**Returns:** Array of enforcement actions, each with `_citation` metadata.

---

## pl_fin_check_currency

Check whether a specific KNF provision reference is currently in force.

**Input:**
| Parameter | Type | Required | Description |
|---|---|---|---|
| `reference` | string | Yes | Full provision reference (e.g. `KNF_REKOMENDACJE D.1.1`) |

**Returns:** Object with `reference`, `status` (`in_force`/`deleted`/`not_yet_in_force`), `effective_date`, `found`.

---

## pl_fin_check_data_freshness

Check how recent the KNF regulation data is and whether a refresh is recommended.

**Input:** None

**Returns:** Object with `last_ingest` (ISO timestamp), `days_since_ingest`, `processed_urls`, `refresh_recommended`, `coverage_type`, `audit_cadence`.

---

## pl_fin_about

Return metadata about this MCP server: version, data source, and tool list.

**Input:** None

**Returns:** Server name, version, description, data source URL, and tool list.
