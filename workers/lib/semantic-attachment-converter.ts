import {
	SemanticAttachmentExtractionError,
	semanticAttachmentText,
	type SemanticRichDocumentFormat,
} from "./semantic-attachment.ts";
import type { Env } from "../types.ts";

type ConversionRequest = {
	conversionOptions?: {
		docx?: { images: { convert: false; maxConvertedImages: 0 } };
		pdf?: {
			metadata: false;
			images: { convert: false; maxConvertedImages: 0 };
		};
	};
};

export type SemanticRichDocumentConversionTransport = {
	convert(
		document: { name: string; blob: Blob },
		options?: ConversionRequest,
	): Promise<unknown>;
};

export type SemanticRichDocumentConverter = {
	convert(input: {
		filename: string;
		mimetype: string;
		format: SemanticRichDocumentFormat;
		bytes: ArrayBuffer;
	}): Promise<string>;
};

export class SemanticRichDocumentProviderError extends Error {
	readonly code: "provider_protocol" | "provider_error";

	constructor(code: "provider_protocol" | "provider_error") {
		super(code);
		this.name = "SemanticRichDocumentProviderError";
		this.code = code;
	}
}

function requestOptions(
	format: SemanticRichDocumentFormat,
): ConversionRequest | undefined {
	if (format === "pdf") {
		return {
			conversionOptions: {
				pdf: {
					metadata: false,
					images: { convert: false, maxConvertedImages: 0 },
				},
			},
		};
	}
	if (format === "docx") {
		return {
			conversionOptions: {
				docx: { images: { convert: false, maxConvertedImages: 0 } },
			},
		};
	}
	return undefined;
}

function providerResult(
	value: unknown,
	input: { filename: string; mimetype: string },
): string {
	if (
		!value ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		!("format" in value)
	) {
		throw new SemanticRichDocumentProviderError("provider_protocol");
	}
	if (
		!("id" in value) ||
		typeof value.id !== "string" ||
		!value.id ||
		!("name" in value) ||
		value.name !== input.filename ||
		!("mimeType" in value) ||
		value.mimeType !== input.mimetype
	) {
		throw new SemanticRichDocumentProviderError("provider_protocol");
	}
	if (value.format === "error") {
		if (
			!("error" in value) ||
			typeof value.error !== "string" ||
			"tokens" in value ||
			"data" in value
		) {
			throw new SemanticRichDocumentProviderError("provider_protocol");
		}
		throw new SemanticAttachmentExtractionError("conversion_rejected");
	}
	if (
		value.format !== "markdown" ||
		"error" in value ||
		!("tokens" in value) ||
		typeof value.tokens !== "number" ||
		!Number.isFinite(value.tokens) ||
		value.tokens < 0 ||
		!("data" in value) ||
		typeof value.data !== "string"
	) {
		throw new SemanticRichDocumentProviderError("provider_protocol");
	}
	return semanticAttachmentText(value.data);
}

export function createSemanticRichDocumentConverter(
	transport: SemanticRichDocumentConversionTransport,
): SemanticRichDocumentConverter {
	return {
		async convert(input) {
			let response: unknown;
			try {
				response = await transport.convert(
					{
						name: input.filename,
						blob: new Blob([input.bytes], { type: input.mimetype }),
					},
					requestOptions(input.format),
				);
			} catch (error) {
				if (
					error instanceof SemanticAttachmentExtractionError ||
					error instanceof SemanticRichDocumentProviderError
				)
					throw error;
				throw new SemanticRichDocumentProviderError("provider_error");
			}
			return providerResult(response, input);
		},
	};
}

export function createWorkersAiSemanticRichDocumentConverter(
	env: Pick<Env, "AI">,
): SemanticRichDocumentConverter {
	return createSemanticRichDocumentConverter({
		// The installed Workers types define the singular binding overload and the
		// DOCX/PDF image controls used here. Cloudflare's binding has no AbortSignal,
		// so the caller owns elapsed timeout and stale-lease fencing.
		// https://developers.cloudflare.com/workers-ai/features/markdown-conversion/usage/binding/
		convert: (document, options) => env.AI.toMarkdown(document, options),
	});
}
