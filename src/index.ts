import "dotenv/config";
import express from "express";
import { z } from "zod";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

const PORT = Number(process.env.PORT || 3000);

const MCP_API_KEY_ENV = process.env.MCP_API_KEY;
const SUPABASE_FUNCTIONS_URL_ENV =
  process.env.SUPABASE_FUNCTIONS_URL;
const SUPABASE_API_KEY_ENV =
  process.env.SUPABASE_API_KEY;
const PUBLIC_BASE_URL_ENV =
  process.env.PUBLIC_BASE_URL;

if (!MCP_API_KEY_ENV) {
  throw new Error(
    "A variavel MCP_API_KEY nao esta configurada.",
  );
}

if (!SUPABASE_FUNCTIONS_URL_ENV) {
  throw new Error(
    "A variavel SUPABASE_FUNCTIONS_URL nao esta configurada.",
  );
}

if (!SUPABASE_API_KEY_ENV) {
  throw new Error(
    "A variavel SUPABASE_API_KEY nao esta configurada.",
  );
}

const MCP_API_KEY: string = MCP_API_KEY_ENV;
const SUPABASE_API_KEY: string =
  SUPABASE_API_KEY_ENV;

const functionsBaseUrl =
  SUPABASE_FUNCTIONS_URL_ENV.replace(/\/+$/, "");

const publicBaseUrl =
  (
    PUBLIC_BASE_URL_ENV ||
    `http://localhost:${PORT}`
  ).replace(/\/+$/, "");

async function callSupabaseFunction(
  functionName: string,
  body: Record<string, unknown>,
): Promise<unknown> {
  const url = `${functionsBaseUrl}/${functionName}`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${SUPABASE_API_KEY}`,
      apikey: SUPABASE_API_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const responseText = await response.text();

  let responseData: unknown;

  try {
    responseData = responseText
      ? JSON.parse(responseText)
      : {};
  } catch {
    responseData = {
      raw_response: responseText,
    };
  }

  if (!response.ok) {
    throw new Error(
      `Supabase retornou HTTP ${response.status}: ${
        typeof responseData === "object"
          ? JSON.stringify(responseData)
          : String(responseData)
      }`,
    );
  }

  return responseData;
}

function toolResult(data: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(data, null, 2),
      },
    ],
  };
}

function toolError(error: unknown) {
  const message =
    error instanceof Error
      ? error.message
      : String(error);

  return {
    isError: true,
    content: [
      {
        type: "text" as const,
        text: message,
      },
    ],
  };
}

function createMcpServer() {
  const server = new McpServer({
    name: "PVKS Transcription Tool",
    version: "1.0.0",
  });

  server.tool(
    "create_transcription_upload",
    "Cria uma sessao de upload de audio. O nome da transcricao deve ser solicitado ao usuario antes de chamar esta ferramenta.",
    {
      filename: z
        .string()
        .min(1)
        .describe(
          "Nome original do arquivo, incluindo extensao.",
        ),

      content_type: z
        .string()
        .min(1)
        .describe(
          "Tipo MIME do audio, por exemplo audio/mpeg ou audio/mp4.",
        ),

      file_size: z
        .number()
        .int()
        .positive()
        .describe(
          "Tamanho exato do arquivo em bytes.",
        ),

      title: z
        .string()
        .optional()
        .describe(
          "Nome da transcricao, informado pelo usuario.",
        ),

      project_name: z
        .string()
        .optional()
        .describe(
          "Campo de compatibilidade para o nome da transcricao.",
        ),

      subtitle: z
        .string()
        .optional()
        .describe(
          "Subtitulo opcional da transcricao.",
        ),

      research_context: z
        .string()
        .optional()
        .describe(
          "Contexto opcional da pesquisa ou entrevista. Ajuda na identificacao do moderador e dos participantes.",
        ),
    },
    {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    async ({
      filename,
      content_type,
      file_size,
      title,
      project_name,
      subtitle,
      research_context,
    }) => {
      try {
        const normalizedTitle =
          title?.trim() ||
          project_name?.trim() ||
          "";

        const normalizedSubtitle =
          subtitle?.trim() || undefined;

        const normalizedResearchContext =
          research_context?.trim() || undefined;

        if (!normalizedTitle) {
          throw new Error(
            "O nome da transcricao e obrigatorio antes de criar a sessao de upload.",
          );
        }

        const data = await callSupabaseFunction(
          "create-upload-url",
          {
            filename,
            content_type,
            file_size,
            project_name:
              normalizedTitle,
            title:
              normalizedTitle,
            subtitle:
              normalizedSubtitle,
            research_context:
              normalizedResearchContext,
          },
        );

        const uploadData = data as {
          transcription_id?: string;
          upload_url?: string;
          title?: string;
          subtitle?: string | null;
          research_context?: string | null;
        };

        if (
          !uploadData.transcription_id ||
          !uploadData.upload_url
        ) {
          return toolResult(data);
        }

        const fragment = new URLSearchParams({
          upload_url:
            uploadData.upload_url,
          transcription_id:
            uploadData.transcription_id,
          filename,
          content_type,
          file_size:
            String(file_size),
          title:
            uploadData.title ||
            normalizedTitle,
        });

        if (
          uploadData.subtitle ||
          normalizedSubtitle
        ) {
          fragment.set(
            "subtitle",
            uploadData.subtitle ||
              normalizedSubtitle ||
              "",
          );
        }

        const uploadPageUrl =
          `${publicBaseUrl}/upload#${fragment.toString()}`;

        return toolResult({
          ...uploadData,
          title:
            uploadData.title ||
            normalizedTitle,
          subtitle:
            uploadData.subtitle ??
            normalizedSubtitle ??
            null,
          research_context:
            uploadData.research_context ??
            normalizedResearchContext ??
            null,
          upload_page_url:
            uploadPageUrl,
          link_label:
            "Clique aqui para enviar o audio",
          instructions:
            "Preserve exatamente transcription_id durante toda a conversa. Nunca tente reconstruir, ler de imagem, corrigir ou pedir que o usuario redigite esse identificador. Apresente somente upload_page_url como link Markdown usando o texto Clique aqui para enviar o audio. Nao mostre upload_url nem exponha a URL completa. Oriente o usuario a selecionar o arquivo, aguardar 100% e responder upload concluido. Quando ele responder upload concluido, use exatamente o transcription_id retornado nesta chamada.",
        });
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.tool(
    "start_transcription",
    "Inicia a transcricao do audio enviado.",
    {
      transcription_id: z
        .string()
        .uuid()
        .describe(
          "ID UUID da transcricao.",
        ),

      language_code: z
        .string()
        .default("pt-BR")
        .describe(
          "Codigo do idioma, por exemplo pt-BR.",
        ),
    },
    {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    async ({
      transcription_id,
      language_code,
    }) => {
      try {
        const data = await callSupabaseFunction(
          "start-transcription",
          {
            transcription_id,
            language_code,
          },
        );

        return toolResult(data);
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.tool(
    "get_transcription_status",
    "Consulta o andamento de uma transcricao.",
    {
      transcription_id: z
        .string()
        .uuid()
        .describe(
          "ID UUID da transcricao.",
        ),
    },
    {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    async ({ transcription_id }) => {
      try {
        const data = await callSupabaseFunction(
          "transcription-status",
          {
            transcription_id,
          },
        );

        const statusData = data as {
          status?: string;
          progress?: number;
          progress_percent?: number;
          google_progress_percent?: number;
          [key: string]: unknown;
        };

        const rawProgress = Number(
          statusData.google_progress_percent ??
          statusData.progress_percent ??
          statusData.progress ??
          0,
        );

        const safeProgress = Number.isFinite(rawProgress)
          ? Math.max(0, Math.min(100, rawProgress))
          : 0;

        const roundedProgress =
          safeProgress >= 100
            ? 100
            : Math.floor(safeProgress / 5) * 5;

        return toolResult({
          ...statusData,
          progress_percent: roundedProgress,
          progress_label:
            roundedProgress >= 100
              ? "Transcrição concluída"
              : `Processamento no Google Cloud: ${roundedProgress}%`,
          instructions:
            "Informe progress_percent ao usuário somente em múltiplos de 5. Preserve o transcription_id original. Nunca leia ou reconstrua o ID a partir de imagens.",
        });
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.tool(
    "get_transcription_result",
    "Recupera o texto final de uma transcricao concluida.",
    {
      transcription_id: z
        .string()
        .uuid()
        .describe(
          "ID UUID da transcricao.",
        ),
    },
    {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    async ({ transcription_id }) => {
      try {
        const data = await callSupabaseFunction(
          "transcription-result",
          {
            transcription_id,
          },
        );

        return toolResult(data);
      } catch (error) {
        return toolError(error);
      }
    },
  );


  server.tool(
    "generate_transcription_document",
    "Gera um documento Word da transcricao.",
    {
      transcription_id: z
        .string()
        .uuid()
        .describe(
          "ID da transcricao concluida.",
        ),

      document_type: z
        .enum([
          "raw",
          "cleaned",
          "executive",
        ])
        .default("raw")
        .describe(
          "Tipo de documento: raw, cleaned ou executive.",
        ),
    },
    {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    async ({
      transcription_id,
      document_type,
    }) => {
      try {
        const data =
          await callSupabaseFunction(
            "generate-transcription-document",
            {
              transcription_id,
              document_type,
            },
          );

        const documentData = data as {
          url?: string;
          file?: string;
          word_count?: number;
          [key: string]: unknown;
        };

        return toolResult({
          success: true,
          document_type,
          document_url:
            documentData.url || "",
          file_name:
            documentData.file || "",
          word_count:
            documentData.word_count || null,
          status:
            "generated",
        });

      } catch (error) {
        return toolError(error);
      }
    },
  );


  server.tool(
    "clean_transcription",
    "Executa a limpeza inteligente de uma transcrição, identifica falantes, organiza o texto e gera o documento Word limpo.",
    {
      transcription_id: z
        .string()
        .uuid()
        .describe(
          "ID UUID da transcrição que será limpa.",
        ),
    },
    {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    async ({
      transcription_id,
    }) => {
      try {

        const data =
          await callSupabaseFunction(
            "clean-transcription",
            {
              transcription_id,
            },
          );

        const result =
          data as {
            document?: {
              document_url?: string;
              file_name?: string;
            };
            document_url?: string;
            file_name?: string;
            status?: string;
            [key: string]: unknown;
          };


        return toolResult({

          success:
            true,

          transcription_id,

          status:
            result.status ||
            "completed",

          document_url:
            result.document?.document_url ||
            result.document_url ||
            "",

          file_name:
            result.document?.file_name ||
            result.file_name ||
            "",

          message:
            "Transcrição limpa e documento Word gerado com sucesso.",

        });


      } catch (error) {

        return toolError(error);

      }
    },
  );


  server.tool(
    "get_transcription_progress",
    "Consulta o progresso atual de uma transcrição em processamento.",
    {
      transcription_id: z
        .string()
        .uuid()
        .describe(
          "ID UUID da transcrição.",
        ),
    },
    {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    async ({
      transcription_id,
    }) => {

      try {

        const data =
          await callSupabaseFunction(
            "transcription-status",
            {
              transcription_id,
            },
          );


        const statusData =
          data as {
            status?: string;
            progress?: number;
            progress_percent?: number;
            error_message?: string;
            [key: string]: unknown;
          };


        const progress =
          statusData.progress_percent ??
          statusData.progress ??
          0;


        return toolResult({

          transcription_id,

          status:
            statusData.status ||
            "unknown",

          progress_percent:
            progress,

          message:
            statusData.status === "completed"
              ? "Transcrição concluída."
              : statusData.status === "processing"
              ? `Transcrição em processamento: ${progress}%`
              : "Aguardando processamento.",

          error_message:
            statusData.error_message ||
            null,

        });


      } catch (error) {

        return toolError(error);

      }

    },
  );


  return server;
}

const app = express();

app.use(express.json());

app.use(
  express.static("public"),
);

app.get("/upload", (_req, res) => {
  res.sendFile(
    "upload.html",
    {
      root: "public",
    },
  );
});

app.get("/", (_req, res) => {
  res.status(200).json({
    name: "PVKS Transcription Tool",
    status: "online",
    endpoint: "/mcp",
  });
});

app.get("/health", (_req, res) => {
  res.status(200).json({
    status: "ok",
  });
});

app.post("/api/upload-complete", async (req, res) => {
  const transcriptionId =
    typeof req.body?.transcription_id === "string"
      ? req.body.transcription_id.trim()
      : "";

  const uuidPattern =
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

  if (
    !transcriptionId ||
    !uuidPattern.test(transcriptionId)
  ) {
    res.status(400).json({
      error: "transcription_id invalido.",
    });
    return;
  }

  try {

    const startResult =
      await callSupabaseFunction(
        "start-transcription",
        {
          transcription_id:
            transcriptionId,
          language_code:
            "pt-BR",
        },
      );


    res.status(200).json({
      started: true,
      transcription_id:
        transcriptionId,
      result:
        startResult,
    });


  } catch (error) {

    const message =
      error instanceof Error
        ? error.message
        : String(error);


    res.status(500).json({
      error:
        "Nao foi possivel iniciar a transcricao automaticamente.",
      details:
        message,
    });

  }
});


app.get(
  "/api/transcription-status/:transcriptionId",
  async (req, res) => {
    const transcriptionId =
      req.params.transcriptionId?.trim() || "";

    const uuidPattern =
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

    if (
      !transcriptionId ||
      !uuidPattern.test(transcriptionId)
    ) {
      res.status(400).json({
        error: "transcription_id invalido.",
      });
      return;
    }

    try {
      const data =
        await callSupabaseFunction(
          "transcription-status",
          {
            transcription_id:
              transcriptionId,
          },
        );

      res.status(200).json(data);
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : String(error);

      res.status(500).json({
        error:
          "Nao foi possivel consultar o andamento.",
        details: message,
      });
    }
  },
);

app.all("/mcp", async (req, res) => {
  const authorization =
    req.headers.authorization;

  if (
    authorization !==
      `Bearer ${MCP_API_KEY}`
  ) {
    res.status(401).json({
      error: "Unauthorized",
    });
    return;
  }

  const server = createMcpServer();

  const transport =
    new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });

  res.on("close", async () => {
    await transport.close();
    await server.close();
  });

  await server.connect(transport);

  await transport.handleRequest(
    req,
    res,
    req.body,
  );
});

app.listen(PORT, () => {
  console.log(
    `PVKS MCP Server executando na porta ${PORT}`,
  );
});
