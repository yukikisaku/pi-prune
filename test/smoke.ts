import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runPrune, testInternals } from "../index.ts";

function messageEntry(id: string, message: Record<string, unknown>) {
	return { type: "message", id, parentId: null, timestamp: new Date().toISOString(), message };
}

function createCtx(entries: any[], sessionFile?: string) {
	let rewrites = 0;
	const customEntries: unknown[] = [];
	return {
		mode: "print",
		ui: { setEditorText() {}, notify() {} },
		waitForIdle: async () => {},
		sessionManager: {
			getBranch: () => entries,
			getSessionFile: () => sessionFile,
			_rewriteFile: () => { rewrites++; },
			appendCustomEntry: (_type: string, data: unknown) => { customEntries.push(data); return "custom"; },
		},
		get rewrites() { return rewrites; },
		customEntries,
	} as any;
}

assert.deepEqual(testInternals.parsePruneTargets(""), ["tool", "thinking"]);
assert.deepEqual(testInternals.parsePruneTargets("all"), ["tool", "thinking"]);
assert.deepEqual(testInternals.parsePruneTargets("tool"), ["tool"]);
assert.deepEqual(testInternals.parsePruneTargets("thinking"), ["thinking"]);
assert.match((testInternals.parsePruneTargets("block") as { error: string }).error, /block/);

const toolCallEntry = messageEntry("tool-call", {
	role: "assistant",
	content: [
		{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: "echo heavy && ".repeat(200), timeout: 10 } },
	],
});
const toolEntry = messageEntry("tool", {
	role: "toolResult",
	toolCallId: "call-1",
	toolName: "bash",
	content: [{ type: "text", text: "heavy output ".repeat(500) }],
	details: { diff: "+ changed\n".repeat(300), patch: "@@ patch\n".repeat(200) },
	isError: false,
});
const assistantEntry = messageEntry("assistant", {
	role: "assistant",
	content: [
		{ type: "thinking", thinking: "private reasoning ".repeat(200), thinkingSignature: "sig" },
		{ type: "text", text: "visible answer" },
	],
});

assert.equal(testInternals.collectToolRegions([toolCallEntry, toolEntry]).length, 3);
assert.equal(testInternals.collectThinkingRegions([assistantEntry]).length, 1);

const protectedReadCall = messageEntry("call", {
	role: "assistant",
	content: [{ type: "toolCall", id: "read-skill", name: "read", arguments: { path: "skill://abc" } }],
});
const protectedReadResult = messageEntry("protected", {
	role: "toolResult",
	toolCallId: "read-skill",
	toolName: "read",
	content: [{ type: "text", text: "skill body" }],
	details: { diff: "skill diff" },
});
assert.equal(testInternals.collectToolRegions([protectedReadCall, protectedReadResult]).length, 0);

const tmp = mkdtempSync(join(tmpdir(), "pi-prune-"));
try {
	const sessionFile = join(tmp, "session.jsonl");
	const entries = [structuredClone(toolCallEntry), structuredClone(toolEntry), structuredClone(assistantEntry)];
	const ctx = createCtx(entries, sessionFile);
	const result = await runPrune(["tool", "thinking"], ctx);
	assert.equal(result.toolResultsDropped, 1);
	assert.equal(result.toolDetailsDropped, 1);
	assert.equal(result.toolCallArgumentsDropped, 1);
	assert.equal(result.thinkingBlocksDropped, 1);
	assert.equal(ctx.rewrites, 1);
	assert.ok(result.artifactPath?.includes("pi-prune-artifacts"));
	const artifact = readFileSync(result.artifactPath!, "utf8");
	assert.match(artifact, /heavy output/);
	assert.match(artifact, /echo heavy/);
	assert.match(artifact, /changed/);
	assert.match(artifact, /private reasoning/);
	assert.match((entries[1].message as any).content[0].text, /^\[pruned tool ~\d+ tokens/);
	assert.equal((entries[1].message as any).details.pruned, true);
	assert.equal((entries[0].message as any).content[0].arguments.pruned, true);
	assert.deepEqual((entries[2].message as any).content, [{ type: "text", text: "visible answer" }]);
	assert.equal(ctx.customEntries.length, 1);

	const thinkingOnlyEntries = [structuredClone(toolCallEntry), structuredClone(toolEntry), structuredClone(assistantEntry)];
	const thinkingOnly = await runPrune(["thinking"], createCtx(thinkingOnlyEntries, sessionFile));
	assert.equal(thinkingOnly.toolResultsDropped, 0);
	assert.equal(thinkingOnly.toolDetailsDropped, 0);
	assert.equal(thinkingOnly.toolCallArgumentsDropped, 0);
	assert.equal(thinkingOnly.thinkingBlocksDropped, 1);
	assert.equal((thinkingOnlyEntries[1].message as any).content[0].text.startsWith("heavy output"), true);
	assert.equal((thinkingOnlyEntries[0].message as any).content[0].arguments.command.startsWith("echo heavy"), true);

	const toolOnlyEntries = [structuredClone(toolCallEntry), structuredClone(toolEntry), structuredClone(assistantEntry)];
	const toolOnly = await runPrune(["tool"], createCtx(toolOnlyEntries, sessionFile));
	assert.equal(toolOnly.toolResultsDropped, 1);
	assert.equal(toolOnly.toolDetailsDropped, 1);
	assert.equal(toolOnly.toolCallArgumentsDropped, 1);
	assert.equal(toolOnly.thinkingBlocksDropped, 0);
	assert.equal((toolOnlyEntries[2].message as any).content[0].type, "thinking");
} finally {
	rmSync(tmp, { recursive: true, force: true });
}

console.log("pi-prune smoke ok");
