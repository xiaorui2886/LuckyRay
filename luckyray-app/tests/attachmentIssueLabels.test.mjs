import { test } from "node:test";
import assert from "node:assert/strict";
import { linuxPortIssueCodes, resolveAttachmentIssueLabel } from "../src/core/services/attachmentIssueLabels.ts";

const UNRECOGNIZED = "此附件暂未处理，请检查文件位置后重试";

test("pre-existing statuses keep exactly the label they had", () => {
  assert.equal(resolveAttachmentIssueLabel("missing"), "找不到来源附件");
  assert.equal(resolveAttachmentIssueLabel("ambiguous"), "存在多个同名附件");
  assert.equal(resolveAttachmentIssueLabel("attachment-index-pending"), "文件已处理，附件索引仍需刷新");
  assert.equal(resolveAttachmentIssueLabel("knowledge-revision-conflict"), "笔记已变化，请重新检查");
  assert.equal(resolveAttachmentIssueLabel("knowledge-export-capacity"), "导出超过单次容量限制，请缩小范围");
});

test("pre-existing statuses carrying a reason stay unrecognized", () => {
  // Before the Linux port the label was an exact match only, so a step status
  // such as "code: reason" fell through to the generic sentence. It must keep
  // doing so for every code the port did not introduce.
  assert.equal(resolveAttachmentIssueLabel("knowledge-revision-conflict: File changed before operation deletion"), UNRECOGNIZED);
  assert.equal(resolveAttachmentIssueLabel("missing: attachment/图.png"), UNRECOGNIZED);
  assert.equal(resolveAttachmentIssueLabel("knowledge-name-conflict: Destination already exists"), UNRECOGNIZED);
});

test("the access message always wins", () => {
  assert.equal(resolveAttachmentIssueLabel("external-unregistered", "外部文件尚未连接"), "外部文件尚未连接");
  assert.equal(resolveAttachmentIssueLabel("missing", "外部文件尚未连接"), "外部文件尚未连接");
});

test("only the codes this port introduced resolve out of a step status", () => {
  assert.deepEqual([...linuxPortIssueCodes].sort(), [
    "knowledge-exclusive-write-unsupported",
    "knowledge-linux-fs-unsupported",
    "knowledge-linux-rollback-unprovable",
    "knowledge-operation-partial",
  ]);
  assert.equal(resolveAttachmentIssueLabel("knowledge-linux-rollback-unprovable: The original path now holds another file"),
    "回滚未执行，现场已保留");
  assert.equal(resolveAttachmentIssueLabel("knowledge-linux-fs-unsupported: The filesystem does not support a provable rollback"),
    "文件系统不支持安全回滚，未做修改");
  assert.equal(resolveAttachmentIssueLabel("knowledge-exclusive-write-unsupported"), "该操作在本机暂不可用，未做任何修改");
  assert.equal(resolveAttachmentIssueLabel("knowledge-operation-partial: Note move is partial"), "未全部完成，可继续或回滚");
});

test("an unknown status or an unknown code stays generic", () => {
  assert.equal(resolveAttachmentIssueLabel(""), UNRECOGNIZED);
  assert.equal(resolveAttachmentIssueLabel("something-new: reason"), UNRECOGNIZED);
  assert.equal(resolveAttachmentIssueLabel("knowledge-linux-rollback-unprovable: "), "回滚未执行，现场已保留");
});
