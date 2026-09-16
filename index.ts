import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { ExtensionAPI, ExtensionCommandContext, SessionEntry, SessionMessageEntry } from "@earendil-works/pi-coding-agent";

type PruneTarget = "tool" | "thinking";
type ToolPruneKind = "toolContent" | "toolDetails" | "toolCallArguments";
type PruneKind = ToolPruneKind | "thinking";
type ContentBlock = { type: string; text?: string; thinking?: string; id?: string; name?: string; arguments?: Record<string, unknown>; [key: string]: unknown };
type MessageLike = {
	role: string;
	content?: string | ContentBlock[];
	toolCallId?: string;
	toolName?: string;
	details?: Record<string, unknown>;
	isError?: boolean;
	prunedAt?: number;
};
type MutableSessionManager = ExtensionCommandContext["sessionManager"] & {
	_rewriteFile?: () => void;
	appendCustomEntry?: (customType: string, data?: unknown) => string;
};
type PruneRegion = {
	kind: PruneKind;
	entry: SessionMessageEntry;
	blockIndex?: number;
	label: string;
	tokens: number;
	originalText: string;
};
type PruneResult = {
	targets: PruneTarget[];
	toolResultsDropped: number;
	toolDetailsDropped: number;
	toolCallArgumentsDropped: number;
	thinkingBlocksDropped: number;
	tokensFreed: number;
	artifactPath?: string;
};

const COMMAND = "prune";
const CUSTOM_ENTRY_TYPE = "pi-prune";
const ARTIFACT_DIR_NAME = "pi-prune-artifacts";
const SKILL_INTERNAL_URL_PREFIX = "skill://";
const PLACEHOLDER_TOKEN_ESTIMATE = 16;

function countTokens(text: string): number {
	return text.length === 0 ? 0 : Math.ceil(text.length / 4);
}

function stableJson(value: unknown): string {
	return JSON.stringify(value, null, 2);
}

function isPrunedMarker(value: unknown): boolean {
	return Boolean(value && typeof value === "object" && (value as { pruned?: unknown }).pruned === true);
}

function parsePruneTargets(args: string): PruneTarget[] | { error: string } {
	const value = args.trim().toLowerCase();
	if (value === "" || value === "all") return ["tool", "thinking"];
	if (value === "tool") return ["tool"];
	if (value === "thinking") return ["thinking"];
	return { error: `Unknown /prune target "${value}". Use tool or thinking.` };
}

function formatPruneSummary(result: PruneResult): string {
	const parts: string[] = [];
	if (result.toolResultsDropped > 0) parts.push(`${result.toolResultsDropped} tool result${result.toolResultsDropped === 1 ? "" : "s"}`);
	if (result.toolDetailsDropped > 0) parts.push(`${result.toolDetailsDropped} tool detail${result.toolDetailsDropped === 1 ? "" : "s"}`);
	if (result.toolCallArgumentsDropped > 0) parts.push(`${result.toolCallArgumentsDropped} tool call arg${result.toolCallArgumentsDropped === 1 ? "" : "s"}`);
	if (result.thinkingBlocksDropped > 0) parts.push(`${result.thinkingBlocksDropped} thinking block${result.thinkingBlocksDropped === 1 ? "" : "s"}`);
	if (parts.length === 0) return "Nothing to prune.";
	const recover = result.artifactPath ? ` Recover originals: ${result.artifactPath}` : "";
	return `Pruned ${parts.join(" + ")} (~${result.tokensFreed} tokens freed).${recover}`;
}

function notify(ctx: ExtensionCommandContext, message: string, type: "info" | "warning" | "error" = "info"): void {
	if (ctx.mode === "print") {
		console.log(message);
		return;
	}
	ctx.ui.notify(message, type);
}

function textFromContent(content: MessageLike["content"]): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.filter(block => block.type === "text" && typeof block.text === "string").map(block => block.text).join("\n");
}

function collectToolCallsById(entries: readonly SessionEntry[]): Map<string, ContentBlock> {
	const toolCalls = new Map<string, ContentBlock>();
	for (const entry of entries) {
		if (entry.type !== "message") continue;
		const message = entry.message as MessageLike;
		if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
		for (const block of message.content) {
			if (block.type === "toolCall" && typeof block.id === "string") toolCalls.set(block.id, block);
		}
	}
	return toolCalls;
}

function isProtectedToolCall(toolCall: ContentBlock | undefined): boolean {
	if (!toolCall) return false;
	if (toolCall.name === "skill") return true;
	if (toolCall.name !== "read") return false;
	const path = toolCall.arguments?.path;
	return typeof path === "string" && path.startsWith(SKILL_INTERNAL_URL_PREFIX);
}

function isProtectedToolResult(toolResult: MessageLike, toolCall: ContentBlock | undefined): boolean {
	if (toolResult.toolName === "skill") return true;
	return isProtectedToolCall(toolCall);
}

function collectToolRegions(entries: SessionEntry[]): PruneRegion[] {
	const toolCallsById = collectToolCallsById(entries);
	const protectedToolCallIds = new Set<string>();
	const regions: PruneRegion[] = [];

	for (const [id, toolCall] of toolCallsById) {
		if (isProtectedToolCall(toolCall)) protectedToolCallIds.add(id);
	}

	for (const entry of entries) {
		if (entry.type !== "message") continue;
		const message = entry.message as MessageLike;

		if (message.role === "assistant" && Array.isArray(message.content)) {
			for (let i = 0; i < message.content.length; i++) {
				const block = message.content[i];
				if (block?.type !== "toolCall") continue;
				if (typeof block.id === "string" && protectedToolCallIds.has(block.id)) continue;
				if (!block.arguments || Object.keys(block.arguments).length === 0 || isPrunedMarker(block.arguments)) continue;
				const originalText = stableJson(block.arguments);
				regions.push({ kind: "toolCallArguments", entry, blockIndex: i, label: String(block.name ?? "toolCall"), tokens: countTokens(originalText), originalText });
			}
			continue;
		}

		if (message.role !== "toolResult") continue;
		const toolCall = toolCallsById.get(String(message.toolCallId ?? ""));
		if (isProtectedToolResult(message, toolCall)) continue;

		if (message.prunedAt === undefined) {
			const text = textFromContent(message.content);
			if (text.length > 0) regions.push({ kind: "toolContent", entry, label: String(message.toolName ?? "tool"), tokens: countTokens(text), originalText: text });
		}

		if (message.details && Object.keys(message.details).length > 0 && !isPrunedMarker(message.details)) {
			const originalText = stableJson(message.details);
			regions.push({ kind: "toolDetails", entry, label: `${String(message.toolName ?? "tool")}.details`, tokens: countTokens(originalText), originalText });
		}
	}
	return regions;
}

function collectThinkingRegions(entries: SessionEntry[]): PruneRegion[] {
	const regions: PruneRegion[] = [];
	for (const entry of entries) {
		if (entry.type !== "message") continue;
		const message = entry.message as MessageLike;
		if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
		for (let i = 0; i < message.content.length; i++) {
			const block = message.content[i];
			if (block?.type !== "thinking") continue;
			const originalText = stableJson(block);
			regions.push({ kind: "thinking", entry, blockIndex: i, label: "thinking", tokens: countTokens(originalText), originalText });
		}
	}
	return regions;
}

function collectPruneRegions(entries: SessionEntry[], targets: PruneTarget[]): PruneRegion[] {
	const regions: PruneRegion[] = [];
	if (targets.includes("tool")) regions.push(...collectToolRegions(entries));
	if (targets.includes("thinking")) regions.push(...collectThinkingRegions(entries));
	return regions;
}

function savePruneArtifact(ctx: ExtensionCommandContext, regions: PruneRegion[]): string | undefined {
	const sessionFile = ctx.sessionManager.getSessionFile();
	if (!sessionFile) return undefined;
	const artifactId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${Math.random().toString(16).slice(2, 10)}`;
	const artifactDir = join(dirname(sessionFile), ARTIFACT_DIR_NAME);
	const artifactPath = join(artifactDir, `${artifactId}.md`);
	const parts: string[] = [];
	for (let i = 0; i < regions.length; i++) {
		const region = regions[i]!;
		parts.push(`### region ${i + 1} (${region.kind}:${region.label}, ~${region.tokens} tok)`, "", region.originalText, "");
	}
	mkdirSync(artifactDir, { recursive: true });
	writeFileSync(artifactPath, parts.join("\n"), "utf8");
	return artifactPath;
}

function recoverMarker(kind: PruneKind, tokens: number, artifactPath: string | undefined, index: number): Record<string, unknown> {
	return {
		pruned: true,
		kind,
		tokens,
		recover: artifactPath ? `file://${artifactPath} (region ${index + 1})` : undefined,
	};
}

function applyToolContentRegion(region: PruneRegion, artifactPath: string | undefined, index: number): number {
	const message = region.entry.message as MessageLike;
	const replacement = artifactPath ? `[pruned tool ~${region.tokens} tokens — recover: file://${artifactPath} (region ${index + 1})]` : `[pruned tool ~${region.tokens} tokens]`;
	message.content = [{ type: "text", text: replacement }];
	message.prunedAt = Date.now();
	return countTokens(replacement);
}

function applyToolDetailsRegion(region: PruneRegion, artifactPath: string | undefined, index: number): number {
	const message = region.entry.message as MessageLike;
	const replacement = recoverMarker(region.kind, region.tokens, artifactPath, index);
	message.details = replacement;
	return countTokens(stableJson(replacement));
}

function applyToolCallArgumentsRegion(region: PruneRegion, artifactPath: string | undefined, index: number): number {
	const message = region.entry.message as MessageLike;
	if (!Array.isArray(message.content) || region.blockIndex === undefined) return 0;
	const block = message.content[region.blockIndex];
	if (!block || block.type !== "toolCall") return 0;
	const replacement = recoverMarker(region.kind, region.tokens, artifactPath, index);
	block.arguments = replacement;
	return countTokens(stableJson(replacement));
}

function applyThinkingRegions(regions: PruneRegion[]): number {
	let replacementTokens = 0;
	const byEntry = new Map<SessionMessageEntry, number[]>();
	for (const region of regions) {
		if (region.kind !== "thinking" || region.blockIndex === undefined) continue;
		const indexes = byEntry.get(region.entry) ?? [];
		indexes.push(region.blockIndex);
		byEntry.set(region.entry, indexes);
	}
	for (const [entry, indexes] of byEntry) {
		const message = entry.message as MessageLike;
		if (!Array.isArray(message.content)) continue;
		const remove = new Set(indexes);
		message.content = message.content.filter((_block, index) => !remove.has(index));
		if (message.content.length === 0) {
			const replacement = "[thinking pruned]";
			message.content = [{ type: "text", text: replacement }];
			replacementTokens += countTokens(replacement);
		} else {
			replacementTokens += indexes.length * PLACEHOLDER_TOKEN_ESTIMATE;
		}
		message.prunedAt = Date.now();
	}
	return replacementTokens;
}

function rewriteSession(manager: MutableSessionManager): void {
	if (typeof manager._rewriteFile === "function") {
		manager._rewriteFile();
		return;
	}
	throw new Error("This pi version does not expose the session rewrite primitive needed by /prune.");
}

function appendAuditEntry(ctx: ExtensionCommandContext, result: PruneResult): void {
	const manager = ctx.sessionManager as MutableSessionManager;
	if (typeof manager.appendCustomEntry !== "function") return;
	manager.appendCustomEntry(CUSTOM_ENTRY_TYPE, {
		version: 1,
		createdAt: new Date().toISOString(),
		...result,
	});
}

function emptyResult(targets: PruneTarget[]): PruneResult {
	return { targets, toolResultsDropped: 0, toolDetailsDropped: 0, toolCallArgumentsDropped: 0, thinkingBlocksDropped: 0, tokensFreed: 0 };
}

export async function runPrune(targets: PruneTarget[], ctx: ExtensionCommandContext): Promise<PruneResult> {
	await ctx.waitForIdle();
	const manager = ctx.sessionManager as MutableSessionManager;
	const entries = ctx.sessionManager.getBranch();
	const regions = collectPruneRegions(entries, targets);
	if (regions.length === 0) return emptyResult(targets);

	const artifactPath = savePruneArtifact(ctx, regions);
	let toolResultsDropped = 0;
	let toolDetailsDropped = 0;
	let toolCallArgumentsDropped = 0;
	let thinkingBlocksDropped = 0;
	let originalTokens = 0;
	let replacementTokens = 0;
	const thinkingRegions: PruneRegion[] = [];

	regions.forEach((region, index) => {
		originalTokens += region.tokens;
		if (region.kind === "toolContent") {
			replacementTokens += applyToolContentRegion(region, artifactPath, index);
			toolResultsDropped++;
		} else if (region.kind === "toolDetails") {
			replacementTokens += applyToolDetailsRegion(region, artifactPath, index);
			toolDetailsDropped++;
		} else if (region.kind === "toolCallArguments") {
			replacementTokens += applyToolCallArgumentsRegion(region, artifactPath, index);
			toolCallArgumentsDropped++;
		} else {
			thinkingRegions.push(region);
			thinkingBlocksDropped++;
		}
	});
	replacementTokens += applyThinkingRegions(thinkingRegions);

	rewriteSession(manager);
	const result: PruneResult = { targets, toolResultsDropped, toolDetailsDropped, toolCallArgumentsDropped, thinkingBlocksDropped, tokensFreed: Math.max(0, originalTokens - replacementTokens), artifactPath };
	appendAuditEntry(ctx, result);
	return result;
}

export default function piPruneExtension(pi: ExtensionAPI) {
	pi.registerCommand(COMMAND, {
		description: "Prune tool-related data and thinking blocks from session context",
		getArgumentCompletions: prefix => {
			const targets = ["tool", "thinking"];
			return targets.filter(target => target.startsWith(prefix.trim().toLowerCase())).map(target => ({ value: target, label: target }));
		},
		handler: async (args, ctx) => {
			ctx.ui.setEditorText("");
			const targets = parsePruneTargets(args);
			if (!Array.isArray(targets)) {
				notify(ctx, targets.error, "warning");
				return;
			}
			try {
				const result = await runPrune(targets, ctx);
				notify(ctx, formatPruneSummary(result), "info");
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				notify(ctx, `/prune failed: ${message}`, "error");
			}
		},
	});
}

export const testInternals = {
	collectPruneRegions,
	collectThinkingRegions,
	collectToolRegions,
	formatPruneSummary,
	parsePruneTargets,
};
