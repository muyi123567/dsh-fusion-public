import { createHash, createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";

const usage = "用法：node scripts/sign-native-execution-review.mjs --receipt receipt.json --reviewer REVIEWER_ID --verdict passed|failed --summary-file summary.txt --private-key reviewer.pem\n"
  + "校验：node scripts/sign-native-execution-review.mjs --verify review.json --public-key reviewer.pem [--receipt receipt.json]";
const sha256 = value => createHash("sha256").update(value).digest("hex");
const EMPTY_SHA256 = sha256("");
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const HASH = /^[a-f0-9]{64}$/u;
const TIME = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/u;
const RECEIPT_FIELDS_V1 = ["sha256", "taskId", "sourceToken", "attemptId", "jobId", "nodeId", "workerTaskId",
  "commandSha256", "dispatchFingerprint", "startedAt", "finishedAt", "exitCode", "stdout", "stderr"];
const REVIEW_FIELDS = ["taskId", "attemptId", "receiptSha256", "reviewerId", "verdict", "summary", "signature"];
const REQUIRE_SIGN_FIELDS = ["receipt", "reviewer", "verdict", "summary-file", "private-key"];
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

const matches = (pattern, value) => typeof value === "string" && pattern.test(value);
const fieldsMatch = (value, fields) => typeof value === "object" && value !== null && !Array.isArray(value)
  && Object.keys(value).length === fields.length && fields.every(field => Object.hasOwn(value, field));

function validTime(value) {
  if (!matches(TIME, value)) return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp)
    && new Date(timestamp).toISOString() === (value.length === 20 ? `${value.slice(0, -1)}.000Z` : value);
}

function validStream(value) {
  return fieldsMatch(value, ["sha256", "bytes"]) && matches(HASH, value.sha256)
    && Number.isSafeInteger(value.bytes) && value.bytes >= 0
    && (value.bytes === 0) === (value.sha256 === EMPTY_SHA256);
}

function validTaskId(value) {
  return typeof value === "string" && value.length > 0 && Buffer.byteLength(value) <= 2048
    && !/[\u0000-\u0020\u007f]/u.test(value);
}

function validSummary(value) {
  return typeof value === "string" && value.trim() !== "" && Buffer.byteLength(value) <= 2048
    && !value.includes("\0");
}

function safePath(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 512
    && !value.startsWith("/") && !value.includes("\\")
    && !value.split("/").some(part => part === "" || part === "." || part === "..")
    && !/[\u0000-\u001f\u007f]/u.test(value);
}

function validMaterialFile(value, runtime = false) {
  const fields = runtime ? ["path", "digest", "evidence"] : ["path", "digest"];
  return fieldsMatch(value, fields) && safePath(value.path) && matches(HASH, value.digest)
    && (!runtime || value.evidence === "measured");
}

function validMaterials(value, sourceToken, attemptId) {
  if (!fieldsMatch(value, ["expected", "observed"]) || !fieldsMatch(value.expected,
    ["source", "code", "input", "runtime", "config", "artifacts"]) || !fieldsMatch(value.observed,
    ["version", "workspace", "source", "code", "input", "runtime", "config", "artifacts"])) return false;
  const expected = value.expected;
  const observed = value.observed;
  if (!fieldsMatch(expected.source, ["revision", "digest"]) || typeof expected.source.revision !== "string"
    || expected.source.revision.length === 0 || !matches(HASH, expected.source.digest)
    || expected.source.digest !== sourceToken
    || !validMaterialFile(expected.code) || !validMaterialFile(expected.input)
    || !validMaterialFile(expected.runtime, true) || !validMaterialFile(expected.config)
    || expected.runtime.evidence !== "measured" || !Array.isArray(expected.artifacts)
    || !expected.artifacts.every(item => fieldsMatch(item, ["path", "digest", "bytes"])
      && safePath(item.path) && matches(HASH, item.digest) && Number.isSafeInteger(item.bytes) && item.bytes >= 0)
    || observed.version !== 1 || !fieldsMatch(observed.workspace, ["id", "path"])
    || observed.workspace.id !== attemptId || typeof observed.workspace.path !== "string"
    || !observed.workspace.path.startsWith("/") || !fieldsMatch(observed.source, ["revision", "digest"])
    || observed.source.revision !== expected.source.revision || observed.source.digest !== sourceToken
    || !validMaterialFile(observed.code) || !validMaterialFile(observed.input)
    || !validMaterialFile(observed.runtime, true) || !validMaterialFile(observed.config)
    || !Array.isArray(observed.artifacts) || observed.artifacts.length !== expected.artifacts.length) return false;
  if (observed.runtime.evidence !== "measured") return false;
  const same = (left, right) => left.path === right.path && left.digest === right.digest;
  if (!same(expected.code, observed.code) || !same(expected.input, observed.input)
    || !same(expected.runtime, observed.runtime) || !same(expected.config, observed.config)) return false;
  return expected.artifacts.every((item, index) => {
    const actual = observed.artifacts[index];
    return actual !== undefined && actual.path === item.path && actual.digest === item.digest && actual.bytes === item.bytes;
  });
}

function validReceipt(receipt) {
  const hasMaterials = typeof receipt === "object" && receipt !== null && Object.hasOwn(receipt, "materials");
  const hasEnvironment = typeof receipt === "object" && receipt !== null && Object.hasOwn(receipt, "environment");
  const fieldsWithExtras = [...RECEIPT_FIELDS_V1,
    ...(hasMaterials ? ["materials"] : []), ...(hasEnvironment ? ["environment"] : [])];
  if (!fieldsMatch(receipt, fieldsWithExtras)) return false;
  const { sha256: digest, taskId, sourceToken, attemptId, jobId, nodeId, workerTaskId, commandSha256,
    dispatchFingerprint, startedAt, finishedAt, exitCode, stdout, stderr } = receipt;
  if (typeof taskId !== "string" || taskId.length === 0 || Buffer.byteLength(taskId) > 2048
    || /[\u0000-\u0020\u007f]/u.test(taskId)
    || ![attemptId, jobId, nodeId, workerTaskId].every(value => matches(ID, value))
    || ![digest, sourceToken, commandSha256, dispatchFingerprint].every(value => matches(HASH, value))
    || !validTime(startedAt) || !validTime(finishedAt) || Date.parse(startedAt) > Date.parse(finishedAt)
    || !Number.isInteger(exitCode) || exitCode < 0 || exitCode > 255
    || !validStream(stdout) || !validStream(stderr)
    || (hasMaterials && !validMaterials(receipt.materials, sourceToken, attemptId))
    || (hasEnvironment && !validEnvironment(receipt.environment))) return false;
  const fields = [taskId, sourceToken,
    attemptId, jobId, nodeId, workerTaskId, `native-execution:${attemptId}`, commandSha256,
    dispatchFingerprint, startedAt, finishedAt, exitCode, stdout.sha256, stdout.bytes, stderr.sha256, stderr.bytes];
  const digestDomain = hasEnvironment ? "dsh-native-execution-receipt/v3"
    : hasMaterials ? "dsh-native-execution-receipt/v2" : "dsh-native-execution-receipt/v1";
  const extras = hasEnvironment
    ? [receipt.materials ?? null, receipt.environment]
    : hasMaterials ? [receipt.materials] : [];
  return digest === sha256(JSON.stringify([digestDomain, ...fields, ...extras]));
}

function validEnvironment(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const allowed = new Set(["hostId", "expectedDigest", "observedDigest", "policy", "matched", "checkedAt", "source", "items", "reason"]);
  if (!Object.keys(value).every(field => allowed.has(field))) return false;
  const digest = input => input === undefined || matches(/^sha256:[a-f0-9]{64}$/u, input);
  if (!digest(value.hostId) || !digest(value.expectedDigest) || !digest(value.observedDigest)) return false;
  if ((value.policy !== "exact" && value.policy !== "compatible") || typeof value.matched !== "boolean"
    || !validTime(value.checkedAt) || value.source !== "controller-gate") return false;
  if (value.reason !== undefined && (typeof value.reason !== "string" || value.reason.length > 512)) return false;
  if (value.items !== undefined && (!Array.isArray(value.items) || value.items.some(item =>
    typeof item !== "object" || item === null || !["code", "path"].every(key => typeof item[key] === "string")
    || !["block", "warn", "info"].includes(item.severity)))) return false;
  return true;
}

function readOrFail(read, message) {
  try {
    return read();
  } catch {
    throw new Error(message);
  }
}

function createReview(values, tokens, positionals) {
  if (values.verify !== undefined || values["public-key"] !== undefined) throw new Error(usage);
  if (tokens.length !== 5 || positionals.length !== 0
    || REQUIRE_SIGN_FIELDS.some(field => typeof values[field] !== "string" || values[field] === "")) {
    throw new Error(usage);
  }
  const { reviewer: reviewerId, verdict } = values;
  if (!matches(ID, reviewerId) || (verdict !== "passed" && verdict !== "failed")) {
    throw new Error("复核人 ID 或结论无效。结论可选 passed 或 failed。");
  }

  const receipt = readOrFail(() => JSON.parse(utf8.decode(readFileSync(values.receipt))), "无法读取回执 JSON。");
  if (!validReceipt(receipt)) throw new Error("回执字段或 SHA-256 校验失败。");
  const summary = readOrFail(() => utf8.decode(readFileSync(values["summary-file"])), "无法读取 UTF-8 复核摘要。");
  if (!validSummary(summary)) {
    throw new Error("复核摘要须含文字、最多 2048 字节，且不能含 NUL 字符。");
  }

  const privateKey = readOrFail(() => createPrivateKey(readFileSync(values["private-key"])), "无法打开 Ed25519 私钥 PEM 文件。");
  if (privateKey.asymmetricKeyType !== "ed25519") throw new Error("私钥须使用 Ed25519。");
  const { taskId, attemptId, sha256: receiptSha256 } = receipt;
  const bytes = Buffer.from(JSON.stringify(["dsh-native-execution-review/v1", taskId, attemptId,
    receiptSha256, reviewerId, verdict, summary]), "utf8");
  const signature = readOrFail(() => sign(null, bytes, privateKey).toString("base64"), "无法创建审核签名。");
  return { taskId, attemptId, receiptSha256, reviewerId, verdict, summary, signature };
}

function readReviewFile(path) {
  const review = readOrFail(() => JSON.parse(utf8.decode(readFileSync(path))), "无法读取复核 JSON。");
  if (typeof review !== "object" || review === null || Array.isArray(review)
    || !fieldsMatch(review, REVIEW_FIELDS)
    || !validTaskId(review.taskId) || !matches(ID, review.attemptId)
    || !matches(HASH, review.receiptSha256) || !matches(ID, review.reviewerId)
    || (review.verdict !== "passed" && review.verdict !== "failed")
    || !validSummary(review.summary) || typeof review.signature !== "string"
    || !/^[A-Za-z0-9+/]{86}==$/u.test(review.signature)) {
    throw new Error("复核 JSON 字段无效，或不是本工具生成的签名复核。");
  }
  return review;
}

function verifyReview(values) {
  if (values.reviewer !== undefined || values.verdict !== undefined
    || values["summary-file"] !== undefined || values["private-key"] !== undefined) throw new Error(usage);
  const reviewPath = values.verify;
  const keyPath = values["public-key"];
  if (typeof reviewPath !== "string" || reviewPath === ""
    || typeof keyPath !== "string" || keyPath === "") throw new Error(usage);
  const review = readReviewFile(reviewPath);
  const publicKey = readOrFail(() => createPublicKey(readFileSync(keyPath)), "无法打开 Ed25519 公钥 PEM 文件。");
  if (publicKey.asymmetricKeyType !== "ed25519") throw new Error("公钥须使用 Ed25519。");
  const { taskId, attemptId, receiptSha256, reviewerId, verdict, summary, signature } = review;
  const bytes = Buffer.from(JSON.stringify(["dsh-native-execution-review/v1", taskId, attemptId,
    receiptSha256, reviewerId, verdict, summary]), "utf8");
  const signed = readOrFail(() => verify(null, bytes, publicKey, Buffer.from(signature, "base64")),
    "签名无法用该公钥校验。");
  if (!signed) throw new Error("签名校验失败：复核内容、结论或签名与该公钥不匹配。");

  let receiptBound = false;
  if (values.receipt !== undefined) {
    const receipt = readOrFail(() => JSON.parse(utf8.decode(readFileSync(values.receipt))), "无法读取回执 JSON。");
    if (!validReceipt(receipt)) throw new Error("回执字段或 SHA-256 校验失败。");
    if (receipt.sha256 !== receiptSha256 || receipt.taskId !== taskId || receipt.attemptId !== attemptId) {
      throw new Error("复核未绑定到该回执：回执摘要、任务或 attempt 不一致。");
    }
    receiptBound = true;
  }
  return { verified: true, taskId, attemptId, receiptSha256, reviewerId, verdict,
    summaryBytes: Buffer.byteLength(summary), receiptBound };
}

const args = process.argv.slice(2);
if (args.length === 1 && args[0] === "--help") {
  console.log(usage);
} else {
  try {
    const { values, tokens, positionals } = readOrFail(() => parseArgs({ args, tokens: true, options: {
      receipt: { type: "string" }, reviewer: { type: "string" }, verdict: { type: "string" },
      "summary-file": { type: "string" }, "private-key": { type: "string" },
      verify: { type: "string" }, "public-key": { type: "string" },
    } }), usage);
    console.log(JSON.stringify(values.verify === undefined
      ? createReview(values, tokens, positionals)
      : verifyReview(values), null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
