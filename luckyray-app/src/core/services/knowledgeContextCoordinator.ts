export type LatestDrainCoordinatorOptions = {
  onError?(error: unknown): void;
};

export type LatestDrainSource<T> = {
  submit(value: T): Promise<void>;
  dispose(finalValue?: T): void;
};

export type LatestDrainCoordinator<T> = {
  createSource(): LatestDrainSource<T>;
  flush(): Promise<void>;
};

type Request<T> = {
  generation: number;
  sourceId: number | null;
  value: T;
};

type Waiter = {
  generation: number;
  sourceId: number;
  resolve(): void;
};

export function createLatestDrainCoordinator<T>(
  run: (value: T) => Promise<void>,
  options: LatestDrainCoordinatorOptions = {},
): LatestDrainCoordinator<T> {
  let nextSourceId = 0;
  let generation = 0;
  let latestGeneration = 0;
  let inFlight: Request<T> | null = null;
  let pending: Request<T> | null = null;
  const activeSources = new Set<number>();
  const waiters: Waiter[] = [];

  const resolveWaiters = (predicate: (waiter: Waiter) => boolean) => {
    for (let index = waiters.length - 1; index >= 0; index -= 1) {
      const waiter = waiters[index];
      if (!predicate(waiter)) continue;
      waiters.splice(index, 1);
      waiter.resolve();
    }
  };

  const startNext = () => {
    if (inFlight || !pending) return;
    const request = pending;
    pending = null;
    if (request.sourceId !== null && !activeSources.has(request.sourceId)) {
      resolveWaiters((waiter) => waiter.generation <= request.generation);
      startNext();
      return;
    }
    inFlight = request;
    let operation: Promise<void>;
    try {
      operation = run(request.value);
    } catch (error) {
      operation = Promise.reject(error);
    }
    Promise.resolve(operation)
      .catch((error) => {
        const sourceIsCurrent = request.sourceId === null || activeSources.has(request.sourceId);
        if (sourceIsCurrent && request.generation === latestGeneration && !pending) options.onError?.(error);
      })
      .finally(() => {
        if (inFlight === request) inFlight = null;
        resolveWaiters((waiter) => waiter.generation <= request.generation);
        startNext();
      });
  };

  const enqueue = (sourceId: number | null, value: T, waitForCompletion: boolean) => {
    generation += 1;
    latestGeneration = generation;
    pending = { generation, sourceId, value };
    const promise = waitForCompletion && sourceId !== null
      ? new Promise<void>((resolve) => waiters.push({ generation, sourceId, resolve }))
      : Promise.resolve();
    startNext();
    return promise;
  };

  return {
    async flush() {
      while (inFlight || pending) {
        const targetGeneration = latestGeneration;
        await new Promise<void>((resolve) => waiters.push({ generation: targetGeneration, sourceId: 0, resolve }));
        if (targetGeneration === latestGeneration && !inFlight && !pending) return;
      }
    },
    createSource() {
      const sourceId = ++nextSourceId;
      let disposed = false;
      activeSources.add(sourceId);
      return {
        submit(value) {
          if (disposed) return Promise.resolve();
          return enqueue(sourceId, value, true);
        },
        dispose(finalValue?: T) {
          if (disposed) return;
          disposed = true;
          activeSources.delete(sourceId);
          if (pending?.sourceId === sourceId) pending = null;
          resolveWaiters((waiter) => waiter.sourceId === sourceId);
          if (arguments.length > 0) enqueue(null, finalValue as T, false);
        },
      };
    },
  };
}
