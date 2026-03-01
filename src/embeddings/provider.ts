import { embedMany } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createMistral } from "@ai-sdk/mistral";
import { createCohere } from "@ai-sdk/cohere";
import { createAmazonBedrock } from "@ai-sdk/amazon-bedrock";
import { config } from "../config.js";
import { getOrCreateProjectEmbeddingConfig, resolveProviderApiKey } from "./config.js";

type EmbedderPipeline = (
  texts: string[],
  options: { pooling: string; normalize: boolean },
) => Promise<{ tolist: () => number[][] }>;

const localEmbedderByModel = new Map<string, Promise<EmbedderPipeline>>();

async function getLocalEmbedder(modelId: string): Promise<EmbedderPipeline> {
  const existing = localEmbedderByModel.get(modelId);
  if (existing) return existing;

  const created = (async () => {
      const { pipeline } = await import("@huggingface/transformers");
      const pipe = await (pipeline as unknown as (
        task: string,
        model: string,
        options: { device: string },
      ) => Promise<unknown>)("feature-extraction", modelId, {
        device: "auto",
      });
      return pipe as EmbedderPipeline;
    })();

  localEmbedderByModel.set(modelId, created);
  return created;
}

function assertDimensions(
  embeddings: number[][],
  expectedDimensions: number,
): void {
  if (embeddings.length === 0) return;
  const actual = embeddings[0].length;
  if (actual !== expectedDimensions) {
    throw new Error(
      `Embedding dimension mismatch: expected ${expectedDimensions}, got ${actual}`,
    );
  }
}

async function embedManyWithOpenAI(
  projectId: string,
  model: string,
  dimensions: number,
  values: string[],
  providerOptions: Record<string, unknown>,
): Promise<{ embeddings: number[][]; usageTokens: number }> {
  const apiKey = await resolveProviderApiKey(projectId, "openai");
  if (!apiKey) {
    throw new Error(
      "No OpenAI API key configured. Set a project key or OPENAI_API_KEY in the environment.",
    );
  }

  const openai = createOpenAI({ apiKey });
  const useCustomDimensions = model.startsWith("text-embedding-3-");

  const result = await embedMany({
    model: openai.embedding(model),
    values,
    maxRetries: 2,
    maxParallelCalls: config.EMBEDDING_MAX_PARALLEL_CALLS,
    providerOptions: {
      openai: {
        ...(useCustomDimensions ? { dimensions } : {}),
        ...(providerOptions.openai && typeof providerOptions.openai === "object"
          ? (providerOptions.openai as Record<string, unknown>)
          : {}),
      },
    },
  });

  assertDimensions(result.embeddings, dimensions);
  return { embeddings: result.embeddings, usageTokens: result.usage.tokens };
}

async function embedManyWithGoogle(
  projectId: string,
  model: string,
  dimensions: number,
  values: string[],
  providerOptions: Record<string, unknown>,
): Promise<{ embeddings: number[][]; usageTokens: number }> {
  const apiKey = await resolveProviderApiKey(projectId, "google");
  if (!apiKey) {
    throw new Error(
      "No Google API key configured. Set a project key or GOOGLE_GENERATIVE_AI_API_KEY in the environment.",
    );
  }

  const google = createGoogleGenerativeAI({ apiKey });

  const result = await embedMany({
    model: google.embedding(model),
    values,
    maxRetries: 2,
    maxParallelCalls: config.EMBEDDING_MAX_PARALLEL_CALLS,
    providerOptions: {
      google: {
        outputDimensionality: dimensions,
        ...(providerOptions.google && typeof providerOptions.google === "object"
          ? (providerOptions.google as Record<string, unknown>)
          : {}),
      },
    },
  });

  assertDimensions(result.embeddings, dimensions);
  return { embeddings: result.embeddings, usageTokens: result.usage.tokens };
}

async function embedManyWithMistral(
  projectId: string,
  model: string,
  dimensions: number,
  values: string[],
): Promise<{ embeddings: number[][]; usageTokens: number }> {
  const apiKey = await resolveProviderApiKey(projectId, "mistral");
  if (!apiKey) {
    throw new Error(
      "No Mistral API key configured. Set a project key or MISTRAL_API_KEY in the environment.",
    );
  }

  const mistral = createMistral({ apiKey });
  const result = await embedMany({
    model: mistral.embedding(model),
    values,
    maxRetries: 2,
    maxParallelCalls: config.EMBEDDING_MAX_PARALLEL_CALLS,
  });

  assertDimensions(result.embeddings, dimensions);
  return { embeddings: result.embeddings, usageTokens: result.usage.tokens };
}

async function embedManyWithCohere(
  projectId: string,
  model: string,
  dimensions: number,
  values: string[],
): Promise<{ embeddings: number[][]; usageTokens: number }> {
  const apiKey = await resolveProviderApiKey(projectId, "cohere");
  if (!apiKey) {
    throw new Error(
      "No Cohere API key configured. Set a project key or COHERE_API_KEY in the environment.",
    );
  }

  const cohere = createCohere({ apiKey });
  const result = await embedMany({
    model: cohere.embedding(model),
    values,
    maxRetries: 2,
    maxParallelCalls: config.EMBEDDING_MAX_PARALLEL_CALLS,
  });

  assertDimensions(result.embeddings, dimensions);
  return { embeddings: result.embeddings, usageTokens: result.usage.tokens };
}

async function embedManyWithBedrock(
  projectId: string,
  model: string,
  dimensions: number,
  values: string[],
  providerOptions: Record<string, unknown>,
): Promise<{ embeddings: number[][]; usageTokens: number }> {
  const apiKey = await resolveProviderApiKey(projectId, "amazon-bedrock");
  const bedrockOptions = providerOptions.bedrock && typeof providerOptions.bedrock === "object"
    ? (providerOptions.bedrock as Record<string, unknown>)
    : {};
  const region =
    (typeof bedrockOptions.region === "string" && bedrockOptions.region.length > 0
      ? bedrockOptions.region
      : config.AWS_REGION) ?? undefined;

  if (!region) {
    throw new Error(
      "Amazon Bedrock requires AWS region. Set provider_options.bedrock.region or AWS_REGION.",
    );
  }

  const bedrock = createAmazonBedrock({
    region,
    ...(apiKey ? { apiKey } : {}),
    ...(typeof config.AWS_ACCESS_KEY_ID === "string" && config.AWS_ACCESS_KEY_ID.length > 0
      ? { accessKeyId: config.AWS_ACCESS_KEY_ID }
      : {}),
    ...(typeof config.AWS_SECRET_ACCESS_KEY === "string" &&
    config.AWS_SECRET_ACCESS_KEY.length > 0
      ? { secretAccessKey: config.AWS_SECRET_ACCESS_KEY }
      : {}),
    ...(typeof config.AWS_SESSION_TOKEN === "string" && config.AWS_SESSION_TOKEN.length > 0
      ? { sessionToken: config.AWS_SESSION_TOKEN }
      : {}),
  });

  const result = await embedMany({
    model: bedrock.embedding(model),
    values,
    maxRetries: 2,
    maxParallelCalls: config.EMBEDDING_MAX_PARALLEL_CALLS,
  });

  assertDimensions(result.embeddings, dimensions);
  return { embeddings: result.embeddings, usageTokens: result.usage.tokens };
}

async function embedManyWithLocalModel(
  model: string,
  dimensions: number,
  values: string[],
): Promise<{ embeddings: number[][]; usageTokens: number }> {
  const embed = await getLocalEmbedder(model);
  const output = await embed(values, { pooling: "mean", normalize: true });
  const embeddings = output.tolist();
  assertDimensions(embeddings, dimensions);
  return { embeddings, usageTokens: 0 };
}

export async function embedManyForProject(
  projectId: string,
  values: string[],
): Promise<{
  embeddings: number[][];
  usageTokens: number;
  provider: string;
  model: string;
  dimensions: number;
}> {
  if (values.length === 0) {
    const cfg = await getOrCreateProjectEmbeddingConfig(projectId);
    return {
      embeddings: [],
      usageTokens: 0,
      provider: cfg.provider,
      model: cfg.model,
      dimensions: cfg.dimensions,
    };
  }

  const cfg = await getOrCreateProjectEmbeddingConfig(projectId);

  if (cfg.provider === "openai") {
    const { embeddings, usageTokens } = await embedManyWithOpenAI(
      projectId,
      cfg.model,
      cfg.dimensions,
      values,
      cfg.providerOptions,
    );
    return {
      embeddings,
      usageTokens,
      provider: cfg.provider,
      model: cfg.model,
      dimensions: cfg.dimensions,
    };
  }

  if (cfg.provider === "google") {
    const { embeddings, usageTokens } = await embedManyWithGoogle(
      projectId,
      cfg.model,
      cfg.dimensions,
      values,
      cfg.providerOptions,
    );
    return {
      embeddings,
      usageTokens,
      provider: cfg.provider,
      model: cfg.model,
      dimensions: cfg.dimensions,
    };
  }

  if (cfg.provider === "mistral") {
    const { embeddings, usageTokens } = await embedManyWithMistral(
      projectId,
      cfg.model,
      cfg.dimensions,
      values,
    );
    return {
      embeddings,
      usageTokens,
      provider: cfg.provider,
      model: cfg.model,
      dimensions: cfg.dimensions,
    };
  }

  if (cfg.provider === "cohere") {
    const { embeddings, usageTokens } = await embedManyWithCohere(
      projectId,
      cfg.model,
      cfg.dimensions,
      values,
    );
    return {
      embeddings,
      usageTokens,
      provider: cfg.provider,
      model: cfg.model,
      dimensions: cfg.dimensions,
    };
  }

  if (cfg.provider === "amazon-bedrock") {
    const { embeddings, usageTokens } = await embedManyWithBedrock(
      projectId,
      cfg.model,
      cfg.dimensions,
      values,
      cfg.providerOptions,
    );
    return {
      embeddings,
      usageTokens,
      provider: cfg.provider,
      model: cfg.model,
      dimensions: cfg.dimensions,
    };
  }

  if (cfg.provider === "local_hf") {
    const { embeddings, usageTokens } = await embedManyWithLocalModel(
      cfg.model,
      cfg.dimensions,
      values,
    );
    return {
      embeddings,
      usageTokens,
      provider: cfg.provider,
      model: cfg.model,
      dimensions: cfg.dimensions,
    };
  }

  throw new Error(
    `Unsupported embedding provider '${cfg.provider}'. Configure a supported provider for this project.`,
  );
}

export async function embedQueryForProject(
  projectId: string,
  text: string,
): Promise<{
  embedding: number[];
  provider: string;
  model: string;
  dimensions: number;
  usageTokens: number;
}> {
  const result = await embedManyForProject(projectId, [text]);
  return {
    embedding: result.embeddings[0],
    provider: result.provider,
    model: result.model,
    dimensions: result.dimensions,
    usageTokens: result.usageTokens,
  };
}
