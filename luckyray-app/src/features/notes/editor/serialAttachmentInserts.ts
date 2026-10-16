/** Keep publication and the editor commit in the same serial operation. */
export function createSerialAttachmentInserts() {
  let tail: Promise<unknown> = Promise.resolve();
  let pending = 0;

  return <T>(isCurrent: () => boolean, insert: (queued: boolean) => Promise<T>): Promise<T> => {
    const queued = pending > 0;
    pending += 1;
    const operation = tail.then(async () => {
      if (!isCurrent()) throw new Error("知识库或笔记已切换，请重新插入");
      return insert(queued);
    });
    tail = operation.then(
      () => { pending -= 1; },
      () => { pending -= 1; },
    );
    return operation;
  };
}
