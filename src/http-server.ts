#!/usr/bin/env node

/**
 * HTTP Server Entry Point for Docker Deployment
 *
 * Provides Streamable HTTP transport for remote MCP clients.
 * Use src/index.ts for local stdio-based usage.
 *
 * Endpoints:
 *   GET  /health  — liveness probe
 *   POST /mcp     — MCP Streamable HTTP (session-aware)
 */

import { createServer } from "node:http";
import { readFileSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
  listSourcebooks,
  searchProvisions,
  getProvision,
  searchEnforcement,
  checkProvisionCurrency,
} from "./db.js";
import { buildCitation } from "./citation.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PORT = parseInt(process.env["PORT"] ?? "3000", 10);
const SERVER_NAME = "polish-financial-regulation-mcp";

const RESPONSE_META = {
  disclaimer:
    "This information is provided for reference only and does not constitute legal advice. Always verify against the official KNF source at https://www.knf.gov.pl/.",
  data_age:
    "Data ingested from knf.gov.pl. Use pl_fin_check_data_freshness for last update timestamp.",
  copyright: "© Komisja Nadzoru Finansowego (KNF). Source: knf.gov.pl",
  source_url: "https://www.knf.gov.pl/",
};

let pkgVersion = "0.1.0";
try {
  const pkg = JSON.parse(
    readFileSync(join(__dirname, "..", "package.json"), "utf8"),
  ) as { version: string };
  pkgVersion = pkg.version;
} catch {
  // fallback
}

const TOOLS = [
  {
    name: "pl_fin_search_regulations",
    description:
      "Wyszukiwanie pełnotekstowe w rekomendacjach, wytycznych i stanowiskach KNF. (Full-text search across KNF recommendations, guidelines, and positions.)",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: { type: "string", description: "Zapytanie wyszukiwania (np. 'ryzyko IT', 'outsourcing')" },
        sourcebook: { type: "string", description: "Filtr po sourcebooku (np. KNF_REKOMENDACJE, KNF_WYTYCZNE). Optional." },
        status: {
          type: "string",
          enum: ["in_force", "deleted", "not_yet_in_force"],
          description: "Filtr po statusie przepisu. Optional.",
        },
        limit: { type: "number", description: "Maksymalna liczba wyników (domyślnie 20)." },
      },
      required: ["query"],
    },
  },
  {
    name: "pl_fin_get_regulation",
    description: "Pobiera konkretny przepis KNF według sourcebooka i referencji.",
    inputSchema: {
      type: "object" as const,
      properties: {
        sourcebook: { type: "string", description: "Identyfikator sourcebooka (np. KNF_REKOMENDACJE, KNF_WYTYCZNE)" },
        reference: { type: "string", description: "Referencja przepisu (np. KNF_REKOMENDACJE D.1.1)" },
      },
      required: ["sourcebook", "reference"],
    },
  },
  {
    name: "pl_fin_list_sourcebooks",
    description: "Lista wszystkich sourcebooków KNF z nazwami i opisami.",
    inputSchema: { type: "object" as const, properties: {}, required: [] },
  },
  {
    name: "pl_fin_search_enforcement",
    description: "Wyszukiwanie decyzji administracyjnych KNF — kary, cofnięcia zezwoleń, zakazy.",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: { type: "string", description: "Zapytanie (nazwa firmy, typ naruszenia, itd.)" },
        action_type: {
          type: "string",
          enum: ["fine", "ban", "restriction", "warning"],
          description: "Filtr po typie działania. Optional.",
        },
        limit: { type: "number", description: "Maksymalna liczba wyników (domyślnie 20)." },
      },
      required: ["query"],
    },
  },
  {
    name: "pl_fin_check_currency",
    description: "Sprawdza, czy konkretna referencja przepisu KNF jest aktualnie w mocy.",
    inputSchema: {
      type: "object" as const,
      properties: {
        reference: { type: "string", description: "Referencja przepisu do sprawdzenia" },
      },
      required: ["reference"],
    },
  },
  {
    name: "pl_fin_about",
    description: "Return metadata about this MCP server: version, data source, tool list.",
    inputSchema: { type: "object" as const, properties: {}, required: [] },
  },
  {
    name: "pl_fin_list_sources",
    description:
      "List all data sources used by this MCP server with URLs and descriptions. (Lista źródeł danych z adresami URL i opisami.)",
    inputSchema: { type: "object" as const, properties: {}, required: [] },
  },
  {
    name: "pl_fin_check_data_freshness",
    description:
      "Check how recent the KNF regulation data in this MCP is. Returns last ingest timestamp and whether a refresh is recommended. (Sprawdza aktualność danych KNF.)",
    inputSchema: { type: "object" as const, properties: {}, required: [] },
  },
];

const SearchRegulationsArgs = z.object({
  query: z.string().min(1),
  sourcebook: z.string().optional(),
  status: z.enum(["in_force", "deleted", "not_yet_in_force"]).optional(),
  limit: z.number().int().positive().max(100).optional(),
});

const GetRegulationArgs = z.object({
  sourcebook: z.string().min(1),
  reference: z.string().min(1),
});

const SearchEnforcementArgs = z.object({
  query: z.string().min(1),
  action_type: z.enum(["fine", "ban", "restriction", "warning"]).optional(),
  limit: z.number().int().positive().max(100).optional(),
});

const CheckCurrencyArgs = z.object({
  reference: z.string().min(1),
});

function createMcpServer(): Server {
  const server = new Server(
    { name: SERVER_NAME, version: pkgVersion },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS,
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args = {} } = request.params;

    function textContent(data: unknown) {
      return {
        content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
        _meta: RESPONSE_META,
      };
    }

    function errorContent(message: string, errorType = "TOOL_ERROR") {
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ error: message, _error_type: errorType, _meta: RESPONSE_META }, null, 2),
          },
        ],
        isError: true as const,
      };
    }

    try {
      switch (name) {
        case "pl_fin_search_regulations": {
          const parsed = SearchRegulationsArgs.parse(args);
          const results = searchProvisions({
            query: parsed.query,
            sourcebook: parsed.sourcebook,
            status: parsed.status,
            limit: parsed.limit,
          });
          const resultsWithCitations = results.map((r) => ({
            ...r,
            _citation: buildCitation(
              String(r.reference),
              String(r.title ?? r.reference),
              "pl_fin_get_regulation",
              { sourcebook: String(r.sourcebook_id), reference: String(r.reference) },
            ),
          }));
          return textContent({ results: resultsWithCitations, count: results.length });
        }

        case "pl_fin_get_regulation": {
          const parsed = GetRegulationArgs.parse(args);
          const provision = getProvision(parsed.sourcebook, parsed.reference);
          if (!provision) {
            return errorContent(
              `Przepis nie znaleziony: ${parsed.sourcebook} ${parsed.reference}`,
              "NOT_FOUND",
            );
          }
          const p = provision as Record<string, unknown>;
          return textContent({
            ...p,
            _citation: buildCitation(
              String(p.reference ?? parsed.reference),
              String(p.title ?? p.reference ?? parsed.reference),
              "pl_fin_get_regulation",
              { sourcebook: parsed.sourcebook, reference: parsed.reference },
            ),
          });
        }

        case "pl_fin_list_sourcebooks": {
          const sourcebooks = listSourcebooks();
          return textContent({ sourcebooks, count: sourcebooks.length });
        }

        case "pl_fin_search_enforcement": {
          const parsed = SearchEnforcementArgs.parse(args);
          const results = searchEnforcement({
            query: parsed.query,
            action_type: parsed.action_type,
            limit: parsed.limit,
          });
          const resultsWithCitations = results.map((r) => ({
            ...r,
            _citation: buildCitation(
              String(r.reference_number),
              String(r.firm_name ?? r.reference_number),
              "pl_fin_get_regulation",
              { sourcebook: "KNF_ENFORCEMENT", reference: String(r.reference_number) },
            ),
          }));
          return textContent({ results: resultsWithCitations, count: results.length });
        }

        case "pl_fin_check_currency": {
          const parsed = CheckCurrencyArgs.parse(args);
          const currency = checkProvisionCurrency(parsed.reference);
          return textContent(currency);
        }

        case "pl_fin_about": {
          return textContent({
            name: SERVER_NAME,
            version: pkgVersion,
            description:
              "Komisja Nadzoru Finansowego (KNF) MCP server. Provides access to KNF recommendations (rekomendacje), guidelines (wytyczne), positions (stanowiska), and enforcement actions.",
            data_source: "KNF (https://www.knf.gov.pl/)",
            tools: TOOLS.map((t) => ({ name: t.name, description: t.description })),
          });
        }

        case "pl_fin_list_sources": {
          return textContent({
            sources: [
              {
                id: "KNF_REKOMENDACJE",
                name: "KNF Rekomendacje",
                description:
                  "Recommendations (rekomendacje) issued by Komisja Nadzoru Finansowego for banks and other supervised financial institutions.",
                url: "https://www.knf.gov.pl/regulacje_i_praktyka/regulacje_i_wytyczne/rekomendacje",
                type: "regulatory_publications",
              },
              {
                id: "KNF_WYTYCZNE",
                name: "KNF Wytyczne",
                description:
                  "Guidelines (wytyczne) issued by KNF for financial sector participants on operational, IT, and compliance matters.",
                url: "https://www.knf.gov.pl/regulacje_i_praktyka/regulacje_i_wytyczne/wytyczne",
                type: "regulatory_publications",
              },
              {
                id: "KNF_STANOWISKA",
                name: "KNF Stanowiska",
                description:
                  "Official positions (stanowiska) and statements issued by KNF on regulatory interpretation and supervisory expectations.",
                url: "https://www.knf.gov.pl/regulacje_i_praktyka/regulacje_i_wytyczne/stanowiska",
                type: "regulatory_publications",
              },
            ],
            count: 3,
            authority: "Komisja Nadzoru Finansowego (KNF)",
            authority_url: "https://www.knf.gov.pl/",
          });
        }

        case "pl_fin_check_data_freshness": {
          const statePath = join(__dirname, "..", "data", "ingest-state.json");
          let lastModified: string | null = null;
          let processedUrlCount = 0;
          try {
            const stat = statSync(statePath);
            lastModified = stat.mtime.toISOString();
            const state = JSON.parse(readFileSync(statePath, "utf8")) as {
              processedUrls?: string[];
            };
            processedUrlCount = state.processedUrls?.length ?? 0;
          } catch {
            // state file may not exist
          }
          const now = new Date();
          const lastDate = lastModified ? new Date(lastModified) : null;
          const daysSince = lastDate
            ? Math.floor((now.getTime() - lastDate.getTime()) / 86_400_000)
            : null;
          return textContent({
            last_ingest: lastModified,
            days_since_ingest: daysSince,
            processed_urls: processedUrlCount,
            refresh_recommended: daysSince === null || daysSince > 30,
            coverage_type: "regulatory_publications",
            audit_cadence: "monthly",
            source: "https://www.knf.gov.pl/",
          });
        }

        default:
          return errorContent(`Unknown tool: ${name}`, "UNKNOWN_TOOL");
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return errorContent(`Error executing ${name}: ${message}`, "VALIDATION_ERROR");
    }
  });

  return server;
}

async function main(): Promise<void> {
  const sessions = new Map<
    string,
    { transport: StreamableHTTPServerTransport; server: Server }
  >();

  const httpServer = createServer((req, res) => {
    handleRequest(req, res, sessions).catch((err) => {
      console.error(`[${SERVER_NAME}] Unhandled error:`, err);
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Internal server error" }));
      }
    });
  });

  async function handleRequest(
    req: import("node:http").IncomingMessage,
    res: import("node:http").ServerResponse,
    activeSessions: Map<
      string,
      { transport: StreamableHTTPServerTransport; server: Server }
    >,
  ): Promise<void> {
    const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);

    if (url.pathname === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", server: SERVER_NAME, version: pkgVersion }));
      return;
    }

    if (url.pathname === "/mcp") {
      const sessionId = req.headers["mcp-session-id"] as string | undefined;

      if (sessionId && activeSessions.has(sessionId)) {
        const session = activeSessions.get(sessionId)!;
        await session.transport.handleRequest(req, res);
        return;
      }

      const mcpServer = createMcpServer();
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
      });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- SDK type mismatch with exactOptionalPropertyTypes
      await mcpServer.connect(transport as any);

      transport.onclose = () => {
        if (transport.sessionId) {
          activeSessions.delete(transport.sessionId);
        }
        mcpServer.close().catch(() => {});
      };

      await transport.handleRequest(req, res);

      if (transport.sessionId) {
        activeSessions.set(transport.sessionId, { transport, server: mcpServer });
      }
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
  }

  httpServer.listen(PORT, () => {
    console.error(`${SERVER_NAME} v${pkgVersion} (HTTP) listening on port ${PORT}`);
    console.error(`MCP endpoint:  http://localhost:${PORT}/mcp`);
    console.error(`Health check:  http://localhost:${PORT}/health`);
  });

  process.on("SIGTERM", () => {
    console.error("Received SIGTERM, shutting down...");
    httpServer.close(() => process.exit(0));
  });
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
