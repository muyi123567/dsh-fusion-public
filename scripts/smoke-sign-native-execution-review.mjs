import { strict as assert } from "node:assert";
import { createHash, generateKeyPairSync, verify } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const sha256 = value => createHash("sha256").update(value).digest("hex");
const dir = mkdtempSync(join(tmpdir(), "dsh-native-review-smoke-"));
try {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const keyFile = join(dir, "reviewer.pem");
  const publicKeyFile = join(dir, "reviewer.pub.pem");
  const summaryFile = join(dir, "summary.txt");
  const receiptFile = join(dir, "receipt.json");
  writeFileSync(keyFile, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
  writeFileSync(publicKeyFile, publicKey.export({ type: "spki", format: "pem" }));
  const summary = "独立复核：固定输入的验证命令和产物摘要一致。\n";
  writeFileSync(summaryFile, summary);
  const receipt = {
    taskId: "dsh-native-team:example-task", sourceToken: "a".repeat(64), attemptId: "attempt-example",
    jobId: "verify-example", nodeId: "isolated-worker", workerTaskId: "worker-example",
    commandSha256: sha256("npm test -- --runInBand"), dispatchFingerprint: "b".repeat(64),
    startedAt: "2026-11-20T00:00:00.000Z", finishedAt: "2026-11-20T00:00:01.000Z", exitCode: 0,
    stdout: { sha256: sha256("verified\n"), bytes: 9 }, stderr: { sha256: sha256(""), bytes: 0 },
  };
  receipt.sha256 = sha256(JSON.stringify(["dsh-native-execution-receipt/v1", receipt.taskId, receipt.sourceToken,
    receipt.attemptId, receipt.jobId, receipt.nodeId, receipt.workerTaskId, `native-execution:${receipt.attemptId}`,
    receipt.commandSha256, receipt.dispatchFingerprint, receipt.startedAt, receipt.finishedAt, receipt.exitCode,
    receipt.stdout.sha256, receipt.stdout.bytes, receipt.stderr.sha256, receipt.stderr.bytes]));
  writeFileSync(receiptFile, JSON.stringify(receipt));
  const receiptV1File = join(dir, "receipt-v1.json");
  writeFileSync(receiptV1File, JSON.stringify(receipt));
  const result = spawnSync(process.execPath, ["scripts/sign-native-execution-review.mjs", "--receipt", receiptFile,
    "--reviewer", "reviewer-example", "--verdict", "passed", "--summary-file", summaryFile,
    "--private-key", keyFile], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  const review = JSON.parse(result.stdout);
  assert.deepEqual({ ...review, signature: undefined }, {
    taskId: receipt.taskId, attemptId: receipt.attemptId, receiptSha256: receipt.sha256,
    reviewerId: "reviewer-example", verdict: "passed", summary, signature: undefined,
  });
  assert.match(review.signature, /^[A-Za-z0-9+/]{86}==$/u);
  const bytes = Buffer.from(JSON.stringify(["dsh-native-execution-review/v1", receipt.taskId, receipt.attemptId,
    receipt.sha256, "reviewer-example", "passed", summary]), "utf8");
  assert(verify(null, bytes, publicKey, Buffer.from(review.signature, "base64")));

  const reviewFile = join(dir, "review.json");
  writeFileSync(reviewFile, JSON.stringify(review));
  const verifyArgs = ["scripts/sign-native-execution-review.mjs", "--verify", reviewFile, "--public-key", publicKeyFile];
  const verified = spawnSync(process.execPath, [...verifyArgs, "--receipt", receiptFile], { encoding: "utf8" });
  assert.equal(verified.status, 0, verified.stderr);
  assert.deepEqual(JSON.parse(verified.stdout), {
    verified: true, taskId: receipt.taskId, attemptId: receipt.attemptId, receiptSha256: receipt.sha256,
    reviewerId: "reviewer-example", verdict: "passed", summaryBytes: Buffer.byteLength(summary), receiptBound: true,
  });
  const signatureOnly = spawnSync(process.execPath, verifyArgs, { encoding: "utf8" });
  assert.equal(signatureOnly.status, 0, signatureOnly.stderr);
  assert.equal(JSON.parse(signatureOnly.stdout).receiptBound, false);

  const otherKeyFile = join(dir, "other.pub.pem");
  const other = generateKeyPairSync("ed25519");
  writeFileSync(otherKeyFile, other.publicKey.export({ type: "spki", format: "pem" }));
  const wrongKey = spawnSync(process.execPath, ["scripts/sign-native-execution-review.mjs", "--verify", reviewFile,
    "--public-key", otherKeyFile], { encoding: "utf8" });
  assert.notEqual(wrongKey.status, 0);
  assert.match(wrongKey.stderr, /签名校验失败/u);

  const tamperedFile = join(dir, "tampered.json");
  writeFileSync(tamperedFile, JSON.stringify({ ...review, summary: `${summary}篡改` }));
  const tampered = spawnSync(process.execPath, ["scripts/sign-native-execution-review.mjs", "--verify", tamperedFile,
    "--public-key", publicKeyFile], { encoding: "utf8" });
  assert.notEqual(tampered.status, 0);
  assert.match(tampered.stderr, /签名校验失败/u);

  const extraFieldFile = join(dir, "extra-field.json");
  writeFileSync(extraFieldFile, JSON.stringify({ ...review, note: "unsigned" }));
  const extraField = spawnSync(process.execPath, ["scripts/sign-native-execution-review.mjs", "--verify", extraFieldFile,
    "--public-key", publicKeyFile], { encoding: "utf8" });
  assert.notEqual(extraField.status, 0);
  assert.match(extraField.stderr, /字段无效/u);

  const otherReceiptFile = join(dir, "other-receipt.json");
  const otherReceipt = { ...receipt, attemptId: "attempt-other" };
  otherReceipt.sha256 = sha256(JSON.stringify(["dsh-native-execution-receipt/v1", otherReceipt.taskId,
    otherReceipt.sourceToken, otherReceipt.attemptId, otherReceipt.jobId, otherReceipt.nodeId,
    otherReceipt.workerTaskId, `native-execution:${otherReceipt.attemptId}`, otherReceipt.commandSha256,
    otherReceipt.dispatchFingerprint, otherReceipt.startedAt, otherReceipt.finishedAt, otherReceipt.exitCode,
    otherReceipt.stdout.sha256, otherReceipt.stdout.bytes, otherReceipt.stderr.sha256, otherReceipt.stderr.bytes]));
  writeFileSync(otherReceiptFile, JSON.stringify(otherReceipt));
  const mismatched = spawnSync(process.execPath, ["scripts/sign-native-execution-review.mjs", "--verify", reviewFile,
    "--public-key", publicKeyFile, "--receipt", otherReceiptFile], { encoding: "utf8" });
  assert.notEqual(mismatched.status, 0);
  assert.match(mismatched.stderr, /未绑定到该回执/u);

  const materialDigest = value => sha256(value);
  const materialFile = (path, value) => ({ path, digest: materialDigest(value) });
  const materials = {
    expected: {
      source: { revision: "1", digest: receipt.sourceToken },
      code: materialFile("src/revision.txt", "code"),
      input: materialFile("inputs/test.json", "input"),
      runtime: { ...materialFile("runtime/identity.json", "runtime"), evidence: "measured" },
      config: materialFile("config/checks.json", "config"),
      artifacts: [{ ...materialFile("dist/result.bin", "artifact"), bytes: 8 }],
    },
    observed: {
      version: 1,
      workspace: { id: receipt.attemptId, path: "/var/lib/dsh-fusion/jobs/example/workspace" },
      source: { revision: "1", digest: receipt.sourceToken },
      code: materialFile("src/revision.txt", "code"),
      input: materialFile("inputs/test.json", "input"),
      runtime: { ...materialFile("runtime/identity.json", "runtime"), evidence: "measured" },
      config: materialFile("config/checks.json", "config"),
      artifacts: [{ ...materialFile("dist/result.bin", "artifact"), bytes: 8 }],
    },
  };
  const v2 = { ...receipt, materials };
  v2.sha256 = sha256(JSON.stringify(["dsh-native-execution-receipt/v2", v2.taskId, v2.sourceToken,
    v2.attemptId, v2.jobId, v2.nodeId, v2.workerTaskId, `native-execution:${v2.attemptId}`,
    v2.commandSha256, v2.dispatchFingerprint, v2.startedAt, v2.finishedAt, v2.exitCode,
    v2.stdout.sha256, v2.stdout.bytes, v2.stderr.sha256, v2.stderr.bytes, materials]));
  writeFileSync(receiptFile, JSON.stringify(v2));
  const v2Result = spawnSync(process.execPath, ["scripts/sign-native-execution-review.mjs", "--receipt", receiptFile,
    "--reviewer", "reviewer-example", "--verdict", "passed", "--summary-file", summaryFile,
    "--private-key", keyFile], { encoding: "utf8" });
  assert.equal(v2Result.status, 0, v2Result.stderr);
  const v2ReviewFile = join(dir, "review-v2.json");
  writeFileSync(v2ReviewFile, v2Result.stdout);
  const v2Verified = spawnSync(process.execPath, ["scripts/sign-native-execution-review.mjs", "--verify", v2ReviewFile,
    "--public-key", publicKeyFile, "--receipt", receiptFile], { encoding: "utf8" });
  assert.equal(v2Verified.status, 0, v2Verified.stderr);
  assert.equal(JSON.parse(v2Verified.stdout).receiptBound, true);
  const staleReceipt = spawnSync(process.execPath, ["scripts/sign-native-execution-review.mjs", "--verify", v2ReviewFile,
    "--public-key", publicKeyFile, "--receipt", receiptV1File], { encoding: "utf8" });
  assert.notEqual(staleReceipt.status, 0);
  assert.match(staleReceipt.stderr, /未绑定到该回执/u);
  console.log("native execution review smoke: pass");
} finally {
  rmSync(dir, { recursive: true, force: true });
}
