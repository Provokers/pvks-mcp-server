import "dotenv/config";

import express, {
  type NextFunction,
  type Request,
  type Response,
} from "express";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import {
  StreamableHTTPServerTransport,
} from "@modelcontextprotocol/sdk/server/streamableHttp.js";

import { z } from "zod";

const port = Number(process.env.PORT ?? 3000);

const mcpApiKey = process.env.MCP_API_KEY;
const supabaseFunctionsUrl = process.env.SUPABASE_FUNCTIONS_URL;
const supabaseApiKey = process.env.SUPABASE_API_KEY;

if (!mcpApiKey) {
  throw new Error("MCP_API_KEY não configurada no arquivo .env.");
}

if (!supabaseFunctionsUrl) {
  throw new Error(
    "SUPABASE_FUNCTIONS_URL não configurada no arquivo .env.",
  );
}

if (!supabaseApiKey) {
  throw new Error(
    "SUPABASE_API_KEY não configurada no arquivo .env.",
  );
}

/**
 * Executa uma chamada para uma Edge Function do Supabase.
 */
async function callSupabase(
  path: string,
  options: RequestInit = {},
): Promise<unknown> {
  const url = `${supabaseFunctionsUrl}${path}`;

  const response = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${supabaseApiKey}`,
      "Content-Type": "application/json",
      ...(options.headers ?? {}),
    },
  });

  const rawBody = await response.text();

  let parsedBody: unknown;

  try {
    parsedBody = rawBody ? JSON.parse(rawBody) : {};
  } catch {
    parsedBody = {
      message: rawBody,
    };
  }

  if (!response.ok) {
    throw new Error(
      `Supabase retornou HTTP ${response.status}: ${
        JSON.stringify(parsedBody)
      }`,
    );
  }

  return parsedBody;
}

/**
 * Converte a resposta da API para o formato esperado pelo MCP.
 */
function createToolResult(data: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(data),
      },
    ],
  };
}

/**
 * Cria uma instância do servidor MCP e registra as ferramentas.
 */
function createMcpServer(): McpServer {
  const server = new McpServer({
    name: "PVKS Transcription Tool",
    version: "1.0.0",
  });

  server.tool(
    "create_transcription_upload",
    "Cria uma URL temporária para upload direto de um arquivo de áudio.",
    {
      filename: z.string().min(1),
      content_type: z.string().min(1),
      file_size: z.number().int().positive(),
      project_name: z.string().optional(),
    },
    async (input) => {
      const data = await callSupabase("/create-upload-url", {
        method: "POST",
        body: JSON.stringify(input),
      });

      return createToolResult(data);
    },
  );

  server.tool(
    "start_transcription",
    "Inicia a transcrição de um áudio que já foi enviado ao Google Cloud Storage.",
    {
      transcription_id: z.string().min(1),
      language_code: z.string().default("pt-BR"),
      enable_diarization: z.boolean().default(true),
      min_speaker_count: z.number().int().min(1).default(2),
      max_speaker_count: z.number().int().min(1).default(10),
    },
    async (input) => {
      const data = await callSupabase("/start-transcription", {
        method: "POST",
        body: JSON.stringify(input),
      });

      return createToolResult(data);
    },
  );

  server.tool(
    "get_transcription_status",
    "Consulta o status e o progresso de uma transcrição.",
    {
      transcription_id: z.string().min(1),
    },
    async ({ transcription_id }) => {
      const encodedId = encodeURIComponent(transcription_id);

      const data = await callSupabase(
        `/transcription-status/${encodedId}`,
        {
          method: "GET",
        },
      );

      return createToolResult(data);
    },
  );

  server.tool(
    "get_transcription_result",
    "Recupera o texto ou os segmentos de uma transcrição concluída.",
    {
      transcription_id: z.string().min(1),
      format: z.enum(["text", "segments"]).default("text"),
      offset: z.number().int().min(0).default(0),
      limit: z.number().int().min(1).max(500).default(200),
    },
    async ({
      transcription_id,
      format,
      offset,
      limit,
    }) => {
      const encodedId = encodeURIComponent(transcription_id);

      const query = new URLSearchParams({
        format,
        offset: String(offset),
        limit: String(limit),
      });

      const data = await callSupabase(
        `/transcription-result/${encodedId}?${query.toString()}`,
        {
          method: "GET",
        },
      );

      return createToolResult(data);
    },
  );

  return server;
}

/**
 * Valida a chave enviada pelo ChatGPT.
 */
function authenticate(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const authorization = req.header("authorization");

  if (authorization !== `Bearer ${mcpApiKey}`) {
    res.status(401).json({
      error: "Unauthorized",
    });

    return;
  }

  next();
}

const app = express();

app.use(
  express.json({
    limit: "1mb",
  }),
);

/**
 * Endpoint simples para verificar se o servidor está funcionando.
 */
app.get("/health", (_req, res) => {
  res.status(200).json({
    status: "ok",
    service: "pvks-mcp-server",
    version: "1.0.0",
  });
});

/**
 * Endpoint MCP utilizado pelo ChatGPT.
 */
app.post("/mcp", authenticate, async (req, res) => {
  const server = createMcpServer();

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });

  try {
    await server.connect(transport);

    await transport.handleRequest(
      req,
      res,
      req.body,
    );
  } catch (error) {
    console.error("Erro no servidor MCP:", error);

    if (!res.headersSent) {
      res.status(500).json({
        error: "MCP server error",
      });
    }
  }
});

app.listen(port, "0.0.0.0", () => {
  console.log(
    `PVKS MCP Server ativo em http://localhost:${port}`,
  );
});
